'use strict';
// ============================================================
// S1/F2：通知渠道 + 通知组回归断言
//
// 覆盖（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md F2）：
//   1. 种子迁移幂等：mail/telegram 内置渠道 + default 组（'*'）；
//   2. 模板渲染与 JSON 转义；GET 不携带 body；
//   3. 组路由：事件匹配 / '*' / 禁用组 / 禁用渠道；
//   4. 单通道失败隔离；同 (agent,event) 保序；
//   5. 管理 API CRUD、内置渠道保护、重名 409、渠道测试端点；
//   6. notifyStatus 汇总。
//
// 本文件允许本机 webhook（SSRF 测试见 notify-ssrf.test.js）：
// ALLOW_PRIVATE_WEBHOOK/ALLOW_INSECURE_WEBHOOK 必须在 require 前设置。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'notify-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-notify-test.db';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';
process.env.ALLOW_PRIVATE_WEBHOOK = '1';
process.env.ALLOW_INSECURE_WEBHOOK = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const nodeHttp = require('node:http');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const notify = require('../src/notify');

db.setConfig('notify_config', JSON.stringify({ smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: '' }));

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN };

// 本机 webhook 接收端：记录方法/头/体与到达顺序。
let hookPort = 0;
let received = [];
let hookDelayMs = 0;
const hookServer = nodeHttp.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }, hookDelayMs);
  });
});

before(async () => {
  await new Promise((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
  hookPort = hookServer.address().port;
});

after(async () => {
  await new Promise((r) => hookServer.close(r));
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 忽略 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

const hookUrl = (path) => `http://127.0.0.1:${hookPort}${path}`;

function makeChannel(name, cfg) {
  return db.createNotifyChannel({
    type: 'webhook',
    name,
    config: Object.assign({
      url: hookUrl(`/${name}`),
      method: 'POST',
      content_type: 'json',
      headers: { 'X-Diting-Test': '1' },
      body_template: '',
      verify_tls: true
    }, cfg || {})
  });
}

// 用例间隔离：禁用全部已有组与渠道（含前序用例创建的 '*' 组），
// 避免通配组把后续用例的流量重复计入 received。
function resetNotifyState() {
  for (const g of db.listNotifyGroups()) db.updateNotifyGroup(g.id, { enabled: false });
  for (const c of db.listNotifyChannels()) db.updateNotifyChannel(c.id, { enabled: false });
}

// ---- 1. 种子迁移 ------------------------------------------------------------

test('种子迁移：mail/telegram 内置渠道 + default 组绑定，且幂等', () => {
  const channels = db.listNotifyChannels();
  const types = channels.map((c) => c.type).sort();
  assert.deepStrictEqual(types, ['mail', 'telegram']);

  const groups = db.listNotifyGroups();
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].name, 'default');
  assert.deepStrictEqual(groups[0].events, ['*']);
  assert.strictEqual(groups[0].channel_ids.length, 2);

  // 重复执行不重复插
  db.initNotifyMigrationIfNeeded();
  db.initNotifyMigrationIfNeeded();
  assert.strictEqual(db.listNotifyChannels().length, 2);
  assert.strictEqual(db.listNotifyGroups().length, 1);
});

// ---- 2. 模板渲染 ------------------------------------------------------------

test('模板渲染：JSON 转义 / form 编码 / 未知占位符置空', () => {
  const { render, buildRequestBody } = notify._internal;
  assert.strictEqual(render('{"a":"{{title}}"}', { title: 'x"y\n' }, 'json'), '{"a":"x\\"y\\n"}');
  assert.strictEqual(render('t={{title}}', { title: 'a b&c' }, 'form'), 't=a%20b%26c');
  assert.strictEqual(render('{{missing}}-{{event}}', { event: 'cpu' }, 'text'), '-cpu');

  const body = buildRequestBody({ method: 'POST', content_type: 'json', body_template: '{"title":"{{title}}","event":"{{event}}"}' }, { title: 'T', event: 'cpu' });
  assert.deepStrictEqual(JSON.parse(body), { title: 'T', event: 'cpu' });

  // GET 不携带 body
  assert.strictEqual(buildRequestBody({ method: 'GET' }, { title: 'T' }), undefined);
});

// ---- 3. 组路由 --------------------------------------------------------------

test('组路由：事件匹配 / 不匹配不投递 / 禁用组与禁用渠道被跳过', async () => {
  resetNotifyState();
  received = [];
  const ch = makeChannel('route-main');
  const g = db.createNotifyGroup({ name: 'route-cpu', events: ['cpu'], channel_ids: [ch.id] });

  // 匹配事件 → 投递
  let ok = await notify.sendEvent('cpu', { agentId: 'a1', agentName: 'n1', subject: 'alert', text: 'msg' });
  assert.strictEqual(ok, true);
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].method, 'POST');
  assert.strictEqual(received[0].headers['x-diting-test'], '1');
  const parsed = JSON.parse(received[0].body);
  assert.strictEqual(parsed.title, 'alert');
  assert.strictEqual(parsed.event, 'cpu');
  assert.strictEqual(parsed.agent_id, 'a1');

  // 不匹配事件 → 不投递
  received = [];
  ok = await notify.sendEvent('mem', { agentId: 'a1', subject: 'mem', text: 'x' });
  assert.strictEqual(ok, false);
  assert.strictEqual(received.length, 0);

  // 禁用组 → 不投递
  db.updateNotifyGroup(g.id, { enabled: false });
  received = [];
  ok = await notify.sendEvent('cpu', { agentId: 'a1', subject: 'cpu', text: 'x' });
  assert.strictEqual(ok, false);

  // 启用组但禁用渠道 → 不投递
  db.updateNotifyGroup(g.id, { enabled: true });
  db.updateNotifyChannel(ch.id, { enabled: false });
  received = [];
  ok = await notify.sendEvent('cpu', { agentId: 'a1', subject: 'cpu', text: 'x' });
  assert.strictEqual(ok, false);
});

test("组事件 '*' 匹配任意事件", async () => {
  resetNotifyState();
  received = [];
  const ch = makeChannel('wildcard');
  db.createNotifyGroup({ name: 'wild', events: ['*'], channel_ids: [ch.id] });
  const ok = await notify.sendEvent('quota', { agentId: 'a2', subject: 'q', text: 'x' });
  assert.strictEqual(ok, true);
  assert.strictEqual(received.length, 1);
});

// ---- 4. 失败隔离与保序 ------------------------------------------------------

test('单通道失败隔离：一个通道 5xx 不影响另一个通道投递成功', async () => {
  resetNotifyState();
  received = [];
  const good = makeChannel('iso-good');
  // 指向一个已关闭端口 → 网络错误；验证失败不拖垮 good
  const dead = db.createNotifyChannel({
    type: 'webhook', name: 'iso-dead',
    config: { url: 'http://127.0.0.1:1/dead', method: 'POST', content_type: 'json', headers: {}, body_template: '', verify_tls: true }
  });
  db.createNotifyGroup({ name: 'iso', events: ['disk'], channel_ids: [good.id, dead.id] });
  const ok = await notify.sendEvent('disk', { agentId: 'a3', subject: 'disk', text: 'x' });
  assert.strictEqual(ok, true, '至少一个通道成功即视为成功');
  assert.strictEqual(received.length, 1);
  assert.ok(received[0].url === '/iso-good');
});

test('同 (agent,event) 保序：告警先于恢复到达，且链完成后清理', async () => {
  resetNotifyState();
  received = [];
  hookDelayMs = 80; // 让第一条慢一点，若并发则会乱序
  const ch = makeChannel('order');
  db.createNotifyGroup({ name: 'order', events: ['temp'], channel_ids: [ch.id] });

  const p1 = notify.sendEvent('temp', { agentId: 'a4', subject: 'ALERT', text: 'high' });
  const p2 = notify.sendEvent('temp', { agentId: 'a4', subject: 'RECOVERY', text: 'ok' });
  await Promise.all([p1, p2]);
  hookDelayMs = 0;

  assert.deepStrictEqual(received.map((r) => JSON.parse(r.body).title), ['ALERT', 'RECOVERY']);
  // 链清理：等待微任务后应为 0（无长期驻留，防内存膨胀）
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(notify._internal.pendingChains(), 0);
});

// ---- 5. 管理 API ------------------------------------------------------------

test('API：渠道 CRUD、内置渠道保护、重名 409、单渠道测试', async () => {
  let res = await request(app).get('/api/admin/notify/channels').set(ADMIN);
  assert.strictEqual(res.status, 200);
  const builtin = res.body.find((c) => c.type === 'mail');
  assert.ok(builtin);

  // 内置渠道不可删除 / 不可写 config
  res = await request(app).delete(`/api/admin/notify/channels/${builtin.id}`).set(ADMIN);
  assert.strictEqual(res.status, 400);
  res = await request(app).put(`/api/admin/notify/channels/${builtin.id}`).set(ADMIN).send({ config: { url: 'https://x' } });
  assert.strictEqual(res.status, 400);

  // 创建 webhook
  res = await request(app).post('/api/admin/notify/channels').set(ADMIN).send({
    type: 'webhook', name: 'api-hook',
    config: { url: hookUrl('/api-hook'), method: 'POST', content_type: 'json', headers: {}, body_template: '' }
  });
  assert.strictEqual(res.status, 201);
  const chId = res.body.id;

  // 重名 → 409
  res = await request(app).post('/api/admin/notify/channels').set(ADMIN).send({
    type: 'webhook', name: 'api-hook', config: { url: hookUrl('/dup') }
  });
  assert.strictEqual(res.status, 409);

  // 非法配置 → 400
  res = await request(app).post('/api/admin/notify/channels').set(ADMIN).send({
    type: 'webhook', name: 'bad', config: { url: 'ftp://x' }
  });
  assert.strictEqual(res.status, 400);

  // 单渠道测试（投递到本地 hook）
  received = [];
  res = await request(app).post(`/api/admin/notify/channels/${chId}/test`).set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(received.length, 1);

  // 删除
  res = await request(app).delete(`/api/admin/notify/channels/${chId}`).set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(db.getNotifyChannel(chId), null);
});

test('API：通知组 CRUD 与事件/渠道过滤', async () => {
  const ch = makeChannel('group-api');

  let res = await request(app).post('/api/admin/notify/groups').set(ADMIN).send({
    name: 'api-group', events: ['cpu', 'bogus-event'], channel_ids: [ch.id, 99999]
  });
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(res.body.events, ['cpu'], '非法事件被过滤');
  assert.deepStrictEqual(res.body.channel_ids, [ch.id], '不存在的渠道被过滤');
  const gid = res.body.id;

  // 事件为空 → 400
  res = await request(app).put(`/api/admin/notify/groups/${gid}`).set(ADMIN).send({ events: [] });
  assert.strictEqual(res.status, 400);

  // 部分更新保留未提供字段
  res = await request(app).put(`/api/admin/notify/groups/${gid}`).set(ADMIN).send({ enabled: false });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.enabled, false);
  assert.deepStrictEqual(res.body.events, ['cpu']);

  res = await request(app).get('/api/admin/notify/groups').set(ADMIN);
  assert.ok(Array.isArray(res.body));

  res = await request(app).delete(`/api/admin/notify/groups/${gid}`).set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(db.getNotifyGroup(gid), null);
});

test('API：事件字典与 notifyStatus', async () => {
  let res = await request(app).get('/api/admin/notify/events').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.events.includes('offline'));
  assert.ok(res.body.events.includes('test'));
  assert.ok(res.body.events.includes('ai_daily'));

  const st = notify.notifyStatus();
  assert.strictEqual(typeof st.mail, 'boolean');
  assert.strictEqual(typeof st.telegram, 'boolean');
  assert.strictEqual(typeof st.webhook, 'number');
  assert.ok(st.channels >= 2);
  assert.ok(st.groups >= 1);
});

// ---- 6. /test-alert 汇总入口 ------------------------------------------------

test('/test-alert：无可用通道时 400，有 webhook 时投递成功', async () => {
  // 禁用内置渠道 + 清空/禁用组，确保“无通道”
  for (const c of db.listNotifyChannels()) db.updateNotifyChannel(c.id, { enabled: false });
  for (const g of db.listNotifyGroups()) db.updateNotifyGroup(g.id, { enabled: false });
  let res = await request(app).post('/api/test-alert').set(ADMIN);
  assert.strictEqual(res.status, 400);

  // 建 webhook + 组后应 200
  const ch = makeChannel('test-alert-hook');
  db.createNotifyGroup({ name: 'test-alert', events: ['test'], channel_ids: [ch.id] });
  received = [];
  res = await request(app).post('/api/test-alert').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(received.length, 1);
});
