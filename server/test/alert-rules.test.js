'use strict';
// ============================================================
// S1/F1：告警规则精细化回归断言
//
// 锚定行为（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md F1）：
//   1. 解析链：节点覆盖 > 分组覆盖 > 全局（NULL/缺省 = 继承，字段独立）；
//   2. muted 边界：只压制 cpu/mem/disk/temp 指标类；离线/到期/配额等经营告警不受影响；
//   3. known 语义：null/缺数据样本不参与判定，也不触发恢复；
//   4. 采样窗口：默认 5 样本 / 70% 比例；ALERT_SUSTAIN_SAMPLES 显式设置时退回
//      「连续 N 次全超限」旧行为；
//   5. API：覆盖 CRUD + 审计 + /agents 附带 effective；
//   6. 删除 agent 时同事务清理覆盖行（本库 FK 不强制，见 db.js 建表注释）。
//
// 运行前提与 integration.api.test.js 相同：PORT=0 / ADMIN_ALLOW_HTTP=1 /
// 测试专用 ADMIN_TOKEN / DB_PATH 指向 /tmp 临时库（绝不触碰生产 monitor.db）。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'alertrules-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-alert-rules-test.db';
// 禁服真实通知：仓库 .env 的 SMTP 占位符会激活邮件通道并真实联网。
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
// 确保默认窗口模式（若外部环境残留兼容开关，会改变本文件的默认断言）。
delete process.env.ALERT_SUSTAIN_SAMPLES;

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');

db.setConfig('notify_config', JSON.stringify({ smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: '' }));

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN };
const NOW = Date.now();

after(async () => {
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// insertMetric 对缺省字段有兜底（cpu=0 等），这里只覆盖关心的列。
const put = (id, ts, over) => db.insertMetric(id, Object.assign({ ts }, over || {}));
// createAgent 只返回 {id, token}；updateAgent 需要完整行（NOT NULL name）。
const setGroup = (a, grp) => {
  const row = db.getAgent(a.id);
  db.updateAgent(row.id, Object.assign({}, row, { grp }));
  return db.getAgent(a.id);
};

// ---- 1. 解析链 --------------------------------------------------------------

test('解析链：节点 > 分组 > 全局，字段独立继承；显式 null 回退上层', () => {
  const a = setGroup(db.createAgent({ name: 'resolve-node' }), 'prod');
  db.upsertGroupAlertOverride('prod', { cpu_pct: 70, mem_pct: 60 });

  let eff = alerts.resolveAgentThresholds(a);
  assert.strictEqual(eff.cpuAlert, 70, '分组覆盖生效');
  assert.strictEqual(eff.memAlert, 60, '分组覆盖生效');
  assert.strictEqual(eff.diskAlert, db.resolveAlertThresholds().disk_pct, '未覆盖字段继承全局');

  db.upsertAlertOverride(a.id, { cpu_pct: 50, disk_pct: 75 });
  eff = alerts.resolveAgentThresholds(a);
  assert.strictEqual(eff.cpuAlert, 50, '节点覆盖优先于分组');
  assert.strictEqual(eff.memAlert, 60, '分组字段继续生效');
  assert.strictEqual(eff.diskAlert, 75, '节点字段独立');

  // 显式 null = 清除该字段，回退到分组
  db.upsertAlertOverride(a.id, { cpu_pct: null });
  eff = alerts.resolveAgentThresholds(a);
  assert.strictEqual(eff.cpuAlert, 70, 'null 回退分组');
  assert.strictEqual(eff.diskAlert, 75, '其它节点字段不受影响');
});

test('覆盖值范围钳制：越界/非法 → null（视为未设置），不写入脏值', () => {
  const a = db.createAgent({ name: 'clamp-node' });
  const row = db.upsertAlertOverride(a.id, { cpu_pct: 999, offline_sec: -5, temp_c: 'abc', mem_pct: 80 });
  assert.strictEqual(row.cpu_pct, 100, '上限钳制');
  assert.strictEqual(row.offline_sec, 10, '下限钳制');
  assert.strictEqual(row.temp_c, null, '非数字 → 未设置');
  assert.strictEqual(row.mem_pct, 80, '合法值保留');
});

// ---- 2. muted 边界 ----------------------------------------------------------

test('muted：指标类静音，但离线告警不受影响（经营告警永不静音）', async () => {
  const a = db.createAgent({ name: 'muted-node' });
  db.upsertAlertOverride(a.id, { muted: true });
  for (const ts of [NOW - 30000, NOW - 15000]) {
    put(a.id, ts, { cpu: 99, mem_pct: 99, disk_pct: 99, temp: 99 });
  }
  let r = await alerts.checkAgent({ id: a.id, name: 'muted-node', last_seen: NOW }, NOW);
  assert.strictEqual((r || []).length, 0, '指标告警应被静音');

  // 离线：即便 muted 也必须触发（返回 sendAlertGuarded 的 Promise）
  r = alerts.checkAgent({ id: a.id, name: 'muted-node', last_seen: NOW - 3600 * 1000 }, NOW);
  assert.ok(r && typeof r.then === 'function', '离线告警不应被 muted 压制');
  await r;
});

test('分组 muted 对该组全部节点生效（并集语义）', async () => {
  const a = setGroup(db.createAgent({ name: 'group-muted-node' }), 'mute-grp');
  db.upsertGroupAlertOverride('mute-grp', { muted: true });
  for (const ts of [NOW - 30000, NOW - 15000]) put(a.id, ts, { cpu: 99 });
  // 必须传完整 agent 行（含 grp）——生产路径 check() 传入的即 getAgents() 整行。
  const r = await alerts.checkAgent(Object.assign({}, a, { last_seen: NOW }), NOW);
  assert.strictEqual((r || []).length, 0, '分组静音应压制指标告警');
  assert.strictEqual(alerts.resolveAgentThresholds(a).muted, true);
});

// ---- 3. known 语义 ----------------------------------------------------------

test('known 语义：null 样本不参与判定；已知样本不足 2 个既不触发也不恢复', async () => {
  const a = db.createAgent({ name: 'known-node' });
  put(a.id, NOW - 40000, { temp: 95 });       // 仅 1 个已知超限样本
  put(a.id, NOW - 30000, { temp: null });
  put(a.id, NOW - 20000, { temp: null });

  let r = await alerts.checkAgent({ id: a.id, name: 'known-node', last_seen: NOW }, NOW);
  assert.strictEqual((r || []).length, 0, '已知样本不足 → 不触发');

  // 已有告警态 + 全为 null → 不判定，因此不应发恢复/清状态
  db.setAlertState(a.id, 'temp', NOW - 1000);
  r = await alerts.checkAgent({ id: a.id, name: 'known-node', last_seen: NOW }, NOW);
  assert.ok(db.getAlertState(a.id, 'temp'), '缺数据不应被当成恢复');
});

// ---- 4. 采样窗口 ------------------------------------------------------------

test('采样窗口：5 样本中 4 个超限触发；3 个不触发；恢复同样按比例', async () => {
  // 4/5 超限 → 80% ≥ 70% → 触发
  const a = db.createAgent({ name: 'window-hit' });
  [10, 95, 95, 95, 95].forEach((v, i) => put(a.id, NOW - 50000 + i * 10000, { cpu: v }));
  let r = await alerts.checkAgent({ id: a.id, name: 'window-hit', last_seen: NOW }, NOW);
  assert.strictEqual(r.length, 1, '4/5 超限应触发');

  // 3/5 超限 → 60% < 70% → 不触发
  const b = db.createAgent({ name: 'window-miss' });
  [95, 95, 95, 10, 10].forEach((v, i) => put(b.id, NOW - 50000 + i * 10000, { cpu: v }));
  r = await alerts.checkAgent({ id: b.id, name: 'window-miss', last_seen: NOW }, NOW);
  assert.strictEqual(r.length, 0, '3/5 超限不应触发');

  // 恢复：已有 state + 4/5 低于阈值 → 发一次并清状态
  const c = db.createAgent({ name: 'window-recover' });
  [95, 10, 10, 10, 10].forEach((v, i) => put(c.id, NOW - 50000 + i * 10000, { cpu: v }));
  db.setAlertState(c.id, 'cpu', NOW - 1000);
  r = await alerts.checkAgent({ id: c.id, name: 'window-recover', last_seen: NOW }, NOW);
  assert.strictEqual(r.length, 1, '恢复应发一次通知');
  assert.ok(!db.getAlertState(c.id, 'cpu'), '恢复后清除状态');
});

test('ALERT_SUSTAIN_SAMPLES 兼容模式：窗口=N、比例=1.0（连续 N 次全超限）', () => {
  const out = execFileSync(process.execPath, ['-e', [
    "process.env.ALERT_SUSTAIN_SAMPLES='2';",
    "process.env.DB_PATH=':memory:';",
    "const a=require('./src/alerts');",
    'console.log(JSON.stringify(a.getAlertWindowConfig()));'
  ].join('')], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { DB_PATH: ':memory:', ALERT_SUSTAIN_SAMPLES: '2' })
  }).toString().trim();
  const cfg = JSON.parse(out.split('\n').pop());
  assert.deepStrictEqual(cfg, { window: 2, ratio: 1, legacy: true });
});

test('默认窗口配置：5 样本 / 0.7 比例', () => {
  assert.deepStrictEqual(alerts.getAlertWindowConfig(), { window: 5, ratio: 0.7, legacy: false });
});

// ---- 5. API 契约 ------------------------------------------------------------

test('API：覆盖 CRUD、默认组别名、审计与 /agents 附带 effective', async () => {
  const a = setGroup(db.createAgent({ name: 'api-node' }), 'api-grp');

  let res = await request(app)
    .put(`/api/admin/alert-rules/agent/${a.id}`)
    .set(ADMIN)
    .send({ cpu_pct: 55, muted: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.override.cpu_pct, 55);
  assert.strictEqual(res.body.override.muted, 1);

  res = await request(app).get('/api/admin/alert-rules').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.global && Array.isArray(res.body.agents) && Array.isArray(res.body.groups));

  res = await request(app).get('/api/agents').set(ADMIN);
  const item = res.body.find((x) => x.id === a.id);
  assert.ok(item, '/agents 应包含该节点');
  assert.strictEqual(item.alert.effective.cpu_pct, 55);
  assert.strictEqual(item.alert.muted, true);
  assert.strictEqual(item.alert.overridden, true);

  // 分组路径：'-' 表示未分组默认组
  res = await request(app).put('/api/admin/alert-rules/group/-').set(ADMIN).send({ cpu_pct: 66 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.override.grp, '');

  // 审计留痕
  const logs = db.getAuditLogs({ limit: 20 });
  assert.ok(logs.some((l) => l.action === 'alert_rule_update'), '写操作应写审计日志');

  res = await request(app).delete(`/api/admin/alert-rules/agent/${a.id}`).set(ADMIN);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(db.getAlertOverride(a.id), null, '删除后覆盖行不存在');

  // 清理分组覆盖，避免影响后续用例
  await request(app).delete('/api/admin/alert-rules/group/-').set(ADMIN);
});

test('未知节点：PUT 覆盖返回 404（不创建孤儿覆盖行）', async () => {
  const res = await request(app)
    .put('/api/admin/alert-rules/agent/agt_not_exist')
    .set(ADMIN)
    .send({ cpu_pct: 50 });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(db.getAlertOverride('agt_not_exist'), null);
});

// ---- 6. 级联清理 ------------------------------------------------------------

test('删除 agent 时同事务清理覆盖行（FK 不强制）', () => {
  const a = db.createAgent({ name: 'cleanup-node' });
  db.upsertAlertOverride(a.id, { cpu_pct: 50 });
  assert.ok(db.getAlertOverride(a.id));
  db.deleteAgent(a.id);
  assert.strictEqual(db.getAlertOverride(a.id), null, '覆盖行应随 agent 删除');
});
