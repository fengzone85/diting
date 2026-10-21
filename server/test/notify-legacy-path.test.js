'use strict';
// ============================================================
// S2/F2 收尾：NOTIFY_GROUPS=0 旧直发路径回退验证
//
// notify.js 在 **require 时** 读取 NOTIFY_GROUPS，因此本文件必须在 require 任何
// server/src 模块之前设置它；node --test 每个测试文件都是独立进程，正好用来
// 验证「同一份代码在两种配置下的分流」。
//
// 断言要点：
//   1. groupsEnabled() === false（回退态）；
//   2. GET /api/admin/notify/migration-status 的 groups_enabled === false；
//   3. **回退态下投递完全绕开通知组 / 渠道表**：配好 webhook 渠道 + 订阅它的组，
//      发一条事件后本地 webhook 接收端零请求 —— 证明不会误投到新链路；
//   4. 无 mail/telegram 凭据时 sendEvent 返回 false（旧行为：无通道即失败），
//      供告警态回滚逻辑使用。
//
// 与之互斥的对照文件：notify-migration.test.js（不设该 env = 启用态）。
// ============================================================

process.env.NOTIFY_GROUPS = '0';
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'notify-legacy-admin-token-0123456789ab';
process.env.DB_PATH = '/tmp/diting-notify-legacy-test.db';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const nodeHttp = require('node:http');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

// 必须在 env 设置之后 require
const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const notify = require('../src/notify');

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };

// 本地 webhook 接收端：记录所有到达的请求。
let hookPort = 0;
let received = [];
const hookServer = nodeHttp.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
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
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

test('回退态：groupsEnabled() = false', () => {
  assert.strictEqual(notify.groupsEnabled(), false);
});

test('回退态：迁移状态端点报告 groups_enabled=false', async () => {
  const res = await request(app).get('/api/admin/notify/migration-status').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.groups_enabled, false);
});

test('回退态：投递绕开通知组与渠道表，webhook 零请求', async () => {
  received = [];
  // 配好一个 webhook 渠道 + 订阅 '*' 的组：若走新链路，事件必然打到本地接收端
  const ch = db.createNotifyChannel({
    type: 'webhook',
    name: 'legacy-bypass',
    config: {
      url: `http://127.0.0.1:${hookPort}/legacy`,
      method: 'POST',
      content_type: 'json',
    },
  });
  const g = db.createNotifyGroup({ name: 'legacy-catchall', events: ['*'], channel_ids: [ch.id], enabled: 1 });

  // 无 mail/telegram 凭据 => 旧直发路径无通道可发 => 返回 false
  const ok = await notify.sendEvent('cpu', { subject: '回退路径测试', text: '不应到达 webhook', agentId: 'agt_x' });
  assert.strictEqual(ok, false, '旧路径下无 mail/tg 凭据应返回 false');
  // 等待一拍：若误走新链路，异步投递会在此窗口内打到本地端口
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(received.length, 0, '回退态下 webhook 不应收到任何请求');

  db.deleteNotifyGroup(g.id);
  db.deleteNotifyChannel(ch.id);
});

test('回退态：配了 mail 凭据也不会触达 webhook（旧行为口径）', async () => {
  // 旧路径只看 notify_config 的凭据存在性；渠道表里配 webhook 不应被触达。
  received = [];
  const ch = db.createNotifyChannel({
    type: 'webhook',
    name: 'legacy-bypass-2',
    config: {
      url: `http://127.0.0.1:${hookPort}/legacy2`,
      method: 'POST',
      content_type: 'json',
    },
  });
  db.createNotifyGroup({ name: 'legacy-catchall-2', events: ['*'], channel_ids: [ch.id], enabled: 1 });
  // notify_config 里放一份「看似可用」的 mail 凭据：旧路径会尝试发信并因 SMTP 不可用而失败，
  // 但无论成败都不该触达 webhook。
  db.setConfig('notify_config', JSON.stringify({
    smtp_user: 'u@example.com', smtp_pass: 'p', smtp_host: '127.0.0.1', smtp_port: 1,
    telegram_bot_token: '', telegram_chat_id: '',
  }));
  const ok = await notify.sendEvent('cpu', { subject: '回退路径测试2', text: '仍不应到达 webhook' });
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(received.length, 0, '回退态下 webhook 仍不应收到请求');
  // mail 不可用 => 返回 false（与旧版 sendAlert 的失败语义一致）
  assert.strictEqual(ok, false);

  for (const g of db.listNotifyGroups()) db.deleteNotifyGroup(g.id);
  for (const c of db.listNotifyChannels()) db.deleteNotifyChannel(c.id);
  db.setConfig('notify_config', JSON.stringify({ smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: '' }));
});
