'use strict';
// ============================================================
// F11 回归：删除语义与 7 天缓冲
//
// 锚定行为（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md §5 F11）：
//   1. 删除 = 软删：getAgent/getAgents 立即不可见，getDeletedAgents 可见；
//   2. 软删期间 /report 被拒（agentAuth 走 getAgent → unknown agent）；
//   3. 恢复 = 一条 UPDATE：节点回到列表，identity/配置/历史原样；
//   4. 软删期间 alert_state / alert_overrides / metrics / traffic_state 全部保留
//      （不删 agents 行 ⇒ CASCADE 不触发；状态表保留 ⇒ 冷却连续）；
//   5. purgeDeletedAgents：只清过期软删；显式清 alert_state/alert_overrides
//      （+ 存在的 metrics_hour）、清 trafficCache，最后删 agents 行由 FK CASCADE
//      带走 metrics/traffic_state；
//   6. 未过期软删节点不被 purge 触碰。
//
// 运行前提与 integration.api.test.js 相同：随机端口 + ADMIN_ALLOW_HTTP=1 +
// 独立临时库（绝不触碰生产 monitor.db）。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'softdelete-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-agent-soft-delete-test.db';
// 禁服真实通知（仓库 .env 的 SMTP 占位符会激活邮件通道并真实联网）。
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };
const DAY = 86400000;

after(() => { try { server.close(); } catch { /* 已关闭 */ } });

// 造一个「有状态、有指标、有流量累计、有告警覆盖」的节点。
function mkAgent(name) {
  const a = db.createAgent({ name });
  db.db.prepare('INSERT INTO metrics (agent_id, ts) VALUES (?, ?)').run(a.id, Date.now());
  db.setAlertState(a.id, 'offline', Date.now());
  db.upsertAlertOverride(a.id, { cpu_pct: 50 });
  db.db.prepare(`INSERT OR REPLACE INTO traffic_state
    (agent_id, cycle_key, cycle_start, used_rx, used_tx, last_rx, last_tx, last_ts, updated_at)
    VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)`).run(a.id, 'test', Date.now(), Date.now(), Date.now());
  return a;
}

test('F11：软删立即隐藏全部读路径，状态/指标/流量保留', async () => {
  const a = mkAgent('soft-a');
  assert.ok(db.getAgent(a.id), '删除前可见');

  assert.strictEqual(db.deleteAgent(a.id), 1, '软删应影响 1 行');
  assert.strictEqual(db.getAgent(a.id), undefined, '软删后 getAgent 不可见');
  assert.ok(!db.getAgents().some((x) => x.id === a.id), '软删后列表排除');
  assert.ok(!db.getMonitoredAgents().some((x) => x.id === a.id), '看板/告警遍历排除');
  const row = db.getAgentIncludingDeleted(a.id);
  assert.ok(row && row.deleted_at > 0, '删除时间已落库');
  assert.ok(db.listDeletedAgents().some((x) => x.id === a.id), '最近删除可见');

  // 软删期间一切历史与状态保留（不删 agents 行 ⇒ 不触发 CASCADE）
  assert.ok(db.getAlertState(a.id, 'offline'), 'alert_state 保留（恢复后冷却连续）');
  assert.ok(db.getAlertOverride(a.id), 'alert_overrides 保留');
  assert.ok(db.getLatestMetric(a.id), 'metrics 保留');
  assert.ok(db.db.prepare('SELECT 1 FROM traffic_state WHERE agent_id=?').get(a.id), 'traffic_state 保留');

  // /report 被拒：agentAuth 走 getAgent（软删不可见）
  const rep = await request(app).post('/api/report').set({
    'X-Agent-ID': a.id,
    Authorization: `Bearer ${a.token}`,
    'User-Agent': 'diting-agent-go/1.0.9',
    'X-Forwarded-Proto': 'https'
  }).send({ ts: Date.now(), cpu: 1 });
  assert.ok([401, 403].includes(rep.status), `/report 应拒绝软删节点，实际 ${rep.status}`);
  assert.strictEqual(rep.body.error, 'unknown agent');

  // 恢复：一条 UPDATE，身份与配置原样
  assert.strictEqual(db.restoreAgent(a.id), 1, '恢复应影响 1 行');
  assert.ok(db.getAgent(a.id), '恢复后重新可见');
  assert.strictEqual(db.getAgent(a.id).name, 'soft-a');
  assert.ok(!db.listDeletedAgents().some((x) => x.id === a.id), '恢复后离开最近删除');
});

test('F11：purge 只清过期软删，按序清状态表并由 CASCADE 带走指标/流量', () => {
  const expired = mkAgent('soft-expired');
  const fresh = mkAgent('soft-fresh');
  db.deleteAgent(expired.id);
  db.deleteAgent(fresh.id);
  // 把 expired 的删除时间前移 8 天（模拟缓冲期已过）
  db.db.prepare('UPDATE agents SET deleted_at=? WHERE id=?').run(Date.now() - 8 * DAY, expired.id);

  const purged = db.purgeDeletedAgents();
  assert.ok(purged >= 1, '应至少清理 1 个过期节点');
  assert.strictEqual(db.getAgentIncludingDeleted(expired.id), undefined, '过期节点物理删除');
  assert.ok(db.getAgentIncludingDeleted(fresh.id), '未过期节点保留');
  assert.ok(db.listDeletedAgents().some((x) => x.id === fresh.id), '未过期节点仍在最近删除');

  assert.strictEqual(db.getAlertState(expired.id, 'offline'), undefined, 'alert_state 显式清理');
  assert.strictEqual(db.getAlertOverride(expired.id), null, 'alert_overrides 显式清理');
  assert.strictEqual(db.getLatestMetric(expired.id), undefined, 'metrics 随 CASCADE 删除');
  assert.strictEqual(
    db.db.prepare('SELECT 1 FROM traffic_state WHERE agent_id=?').get(expired.id),
    undefined,
    'traffic_state 随 CASCADE 删除'
  );
  // 未过期节点的数据不受 purge 影响
  assert.ok(db.getLatestMetric(fresh.id), '未过期节点 metrics 保留');
});

test('F11/F7.1：purge 事务化——中途失败整体回滚，不留半清理', () => {
  const a = mkAgent('soft-tx');
  db.deleteAgent(a.id);
  db.db.prepare('UPDATE agents SET deleted_at=? WHERE id=?').run(Date.now() - 8 * DAY, a.id);

  // 在第二条清理语句（alert_overrides）上制造失败：事务应整体回滚。
  db.db.exec("CREATE TRIGGER purge_tx_boom BEFORE DELETE ON alert_overrides BEGIN SELECT RAISE(ABORT, 'purge-tx-boom'); END");
  assert.throws(() => db.purgeDeletedAgents(), /purge-tx-boom/, 'purge 应把底层错误抛出');
  db.db.exec('DROP TRIGGER purge_tx_boom');

  assert.ok(db.getAgentIncludingDeleted(a.id), '回滚后 agents 行仍在');
  assert.ok(db.getAlertState(a.id, 'offline'), '回滚后 alert_state 仍在（事务前序语句被撤销）');
  assert.ok(db.getAlertOverride(a.id), '回滚后 alert_overrides 仍在');
  assert.ok(db.getLatestMetric(a.id), '回滚后 metrics 仍在');

  // 修复后重跑：完整清理
  assert.ok(db.purgeDeletedAgents() >= 1);
  assert.strictEqual(db.getAgentIncludingDeleted(a.id), undefined, '重跑后物理删除');
  assert.strictEqual(db.getAlertOverride(a.id), null, '重跑后覆盖行清除');
});

test('F11：API —— 删除后进入最近删除，restore 端点恢复，重复恢复 404', async () => {
  const a = mkAgent('soft-api');

  const del = await request(app).delete(`/api/agents/${a.id}`).set(ADMIN);
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.grace_days, 7);
  assert.ok(!db.getAgent(a.id), 'API 删除后不可见');

  const list = await request(app).get('/api/agents/deleted').set(ADMIN);
  assert.strictEqual(list.status, 200);
  const row = list.body.items.find((x) => x.id === a.id);
  assert.ok(row, '最近删除列表包含该节点');
  assert.ok(row.days_left >= 6 && row.days_left <= 7, `days_left 应为 6–7，实际 ${row.days_left}`);
  assert.strictEqual(list.body.grace_days, 7);

  const restore = await request(app).post(`/api/agents/${a.id}/restore`).set(ADMIN);
  assert.strictEqual(restore.status, 200);
  assert.ok(db.getAgent(a.id), 'restore 后可见');

  const again = await request(app).post(`/api/agents/${a.id}/restore`).set(ADMIN);
  assert.strictEqual(again.status, 404, '未软删节点恢复应 404');
  assert.strictEqual(again.body.error, 'not_deleted');
});
