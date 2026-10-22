'use strict';
// ============================================================
// 安全审查修复的回归断言（SECURITY_REVIEW_2026-10-17.md 行动计划）
//
// 运行前提与 integration.api.test.js 相同：PORT=0 / ADMIN_ALLOW_HTTP=1 /
// 测试专用 ADMIN_TOKEN / DB_PATH 指向 /tmp 临时库（绝不触碰生产 monitor.db）。
//
// 锚定四条修复的行为：
//   C-1/E2 — resolveAlertThresholds 三级取值（UI 显式 > env > 默认），
//            修复"看板直读 env、告警走 UI 默认合并值"的双源分裂；
//   G4     — SETUP_TOKEN 弱模式拒绝 + 自助注册 agent 默认待确认、
//            待确认期间拒绝上报、管理员批准后放行；
//   C1     — SSE 单 IP 并发上限（第 6 条连接 429）；
//   E3     — observedIntervalSec 按相邻 ts 中位数测算上报间隔。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'sectest-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-security-fixes-test.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN };

after(async () => {
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// ---- C-1/E2：阈值单一取值（三态） -------------------------------------------

test('resolveAlertThresholds：UI 未显式设置时 env 生效（修复前恒为 UI 默认 60、env 不可达）', () => {
  const raw = db.getConfig('ui_settings');
  const envBackup = process.env.OFFLINE_THRESHOLD_SEC;
  try {
    db.setConfig('ui_settings', JSON.stringify({}));
    process.env.OFFLINE_THRESHOLD_SEC = '120';
    assert.strictEqual(db.resolveAlertThresholds().offline_sec, 120, 'env 应在 UI 未设置时生效');
    process.env.OFFLINE_THRESHOLD_SEC = '45';
    assert.strictEqual(db.resolveAlertThresholds().offline_sec, 45);
    delete process.env.OFFLINE_THRESHOLD_SEC;
    assert.strictEqual(db.resolveAlertThresholds().offline_sec, 60, '无 UI 无 env 时回退硬编码默认');
  } finally {
    db.setConfig('ui_settings', raw == null ? '' : raw);
    if (envBackup === undefined) delete process.env.OFFLINE_THRESHOLD_SEC;
    else process.env.OFFLINE_THRESHOLD_SEC = envBackup;
  }
});

test('resolveAlertThresholds：UI 显式设置优先于 env（含"显式设为默认值"不被 env 覆盖）', () => {
  const raw = db.getConfig('ui_settings');
  const envBackup = { o: process.env.OFFLINE_THRESHOLD_SEC, c: process.env.ALERT_CPU_PCT };
  try {
    db.setConfig('ui_settings', JSON.stringify({ alert: { offline_sec: 60, cpu_pct: 55 } }));
    process.env.OFFLINE_THRESHOLD_SEC = '120';
    process.env.ALERT_CPU_PCT = '90';
    const t = db.resolveAlertThresholds();
    assert.strictEqual(t.offline_sec, 60, 'UI 显式设置的 60 应优先于 env 120');
    assert.strictEqual(t.cpu_pct, 55);
    assert.strictEqual(t.mem_pct, 90, 'UI 未设置的项回退 env');
  } finally {
    db.setConfig('ui_settings', raw == null ? '' : raw);
    for (const [k, v] of [['OFFLINE_THRESHOLD_SEC', envBackup.o], ['ALERT_CPU_PCT', envBackup.c]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// ---- G4：SETUP_TOKEN 熵校验 + 待确认流程 ------------------------------------

test('POST /api/setup/register：弱 SETUP_TOKEN（16 位纯数字）→ 403 停用', async () => {
  db.clearSetupToken(); db.unmarkSetupTokenCleared();
  process.env.SETUP_TOKEN = '1234567890123456';
  const res = await request(app).post('/api/setup/register').send({ setup_token: '1234567890123456' });
  assert.strictEqual(res.status, 403);
  assert.match(res.body.error, /过弱/);
  assert.equal(db.getSetupToken(), '', '弱令牌不得被搬进库（否则之后改 .env 也不再生效）');
});

test('POST /api/setup/register：强令牌 → 200 待确认；上报 403；管理员批准后放行', async () => {
  db.clearSetupToken(); db.unmarkSetupTokenCleared();
  const STRONG = 'Str0ng-Setup-Token-9f2a7c41';
  process.env.SETUP_TOKEN = STRONG;
  const reg = await request(app).post('/api/setup/register').send({ setup_token: STRONG, name: 'pending-node' });
  assert.strictEqual(reg.status, 200);
  assert.strictEqual(reg.body.pending, true, '自助注册默认待确认');
  const { agent_id: id, agent_token: token } = reg.body;

  // 待确认期间拒绝上报（带正确 token 才告知 pending，避免无 token 者探测）
  const before = await request(app).post('/api/report')
    .set('X-Agent-ID', id).set('Authorization', 'Bearer ' + token)
    .send({ cpu: 1, mem_total: 1024, mem_used: 512 });
  assert.strictEqual(before.status, 403);
  assert.strictEqual(before.body.error, 'agent pending approval');

  // 待确认 agent 不进入监控面统计（getMonitoredAgents 过滤）
  assert.ok(!db.getMonitoredAgents().some((a) => a.id === id), '待确认 agent 不应出现在监控面');
  assert.ok(db.getAgents().some((a) => a.id === id), '后台全量列表应能看到待确认 agent');

  // 管理员批准
  const ap = await request(app).post(`/api/agents/${id}/approve`).set(ADMIN);
  assert.strictEqual(ap.status, 200);
  assert.strictEqual(ap.body.pending, false);

  // 批准后上报成功，且 interval 字段被接受
  const afterReport = await request(app).post('/api/report')
    .set('X-Agent-ID', id).set('Authorization', 'Bearer ' + token)
    .send({ cpu: 1, mem_total: 1024, mem_used: 512, interval: 15 });
  assert.strictEqual(afterReport.status, 200);
  assert.strictEqual(afterReport.body.ok, true);
  assert.strictEqual(db.getLatestMetric(id).interval, 15, 'interval 字段应落库');
});

// ---- C1：SSE 单 IP 并发上限 --------------------------------------------------

test('SSE /api/clients/sse：单 IP 第 6 条并发连接 → 429（前 5 条 200）', async () => {
  const port = server.address().port;
  const held = [];
  const open = () => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/clients/sse' }, (res) => {
      res.resume(); // 保持连接打开（读到即丢，不处理）
      resolve({ req, res });
    });
    req.on('error', reject);
  });
  try {
    for (let i = 0; i < 5; i++) {
      const c = await open();
      assert.strictEqual(c.res.statusCode, 200, `第 ${i + 1} 条连接应放行`);
      held.push(c);
    }
    const sixth = await open();
    assert.strictEqual(sixth.res.statusCode, 429, '第 6 条并发连接应被限流');
    held.push(sixth);
  } finally {
    for (const c of held) { try { c.req.destroy(); } catch { /* 忽略 */ } }
  }
});

// ---- E3：观测上报间隔（相邻 ts 中位数） --------------------------------------

test('observedIntervalSec：按相邻 ts 中位数测算；无样本回退 agent 上报的 interval；再不行返回 null', () => {
  const { id } = db.createAgent({ name: 'interval-probe' });
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    db.insertMetric(id, { ts: now - (4 - i) * 15000, cpu: 1, mem_total: 1 });
  }
  assert.strictEqual(db.observedIntervalSec(id, 3600000), 15, '等距 15s 上报 → 中位数 15');

  // 样本不足（<3 行）时回退到受控端上报的 interval 字段
  const { id: id2 } = db.createAgent({ name: 'interval-fallback' });
  db.insertMetric(id2, { ts: Date.now(), cpu: 1, mem_total: 1, interval: 42 });
  assert.strictEqual(db.observedIntervalSec(id2, 3600000), 42, '样本不足应回退到上报的 interval');

  // 两者皆无 → null（调用方回退到配置值）
  const { id: id3 } = db.createAgent({ name: 'interval-none' });
  assert.strictEqual(db.observedIntervalSec(id3, 3600000), null);
});
