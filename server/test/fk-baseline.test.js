'use strict';
// ============================================================
// F7.1 认知基线：better-sqlite3 默认 foreign_keys=ON，CASCADE 真实生效
//
// 依据（2026-10-24 真机 + 本仓实测）：better-sqlite3 11.10.0；
// db.js 从未设置 PRAGMA foreign_keys，但连接级 pragma 默认即 1
//（原生 sqlite3 CLI / Python sqlite3 才默认 0——旧注释的认知偏差来源）。
//
// 本测试锁住三件事，防止后续有人按错误假设写清理逻辑：
//   1. 连接默认 foreign_keys = 1；
//   2. 删 agents 行时 metrics / traffic_state 被级联删除
//      （F11 的 purgeDeletedAgents 依赖此行为，不做重复 DELETE）；
//   3. alert_state 无 FK 声明，不会被级联——必须显式清理
//      （purge 的第一步就是它）。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'fk-baseline-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-fk-baseline-test.db';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const db = require('../src/db');

test('F7.1：默认 FK=ON；metrics/traffic_state 级联生效，alert_state 不级联', () => {
  assert.strictEqual(db.db.pragma('foreign_keys', { simple: true }), 1,
    'better-sqlite3 连接应默认开启外键（写码前提）');

  const a = db.createAgent({ name: 'fk-node' });
  db.db.prepare('INSERT INTO metrics (agent_id, ts) VALUES (?, ?)').run(a.id, Date.now());
  db.db.prepare(`INSERT OR REPLACE INTO traffic_state
    (agent_id, cycle_key, cycle_start, used_rx, used_tx, last_rx, last_tx, last_ts, updated_at)
    VALUES (?, 'k', ?, 0, 0, 0, 0, ?, ?)`).run(a.id, Date.now(), Date.now(), Date.now());
  db.setAlertState(a.id, 'offline', Date.now());

  // 直接删 agents 行（模拟旧硬删路径 / purge 的最后一步）
  db.db.prepare('DELETE FROM agents WHERE id = ?').run(a.id);

  assert.strictEqual(db.getLatestMetric(a.id), undefined, 'metrics 应被 CASCADE 删除');
  assert.strictEqual(
    db.db.prepare('SELECT 1 FROM traffic_state WHERE agent_id=?').get(a.id),
    undefined,
    'traffic_state 应被 CASCADE 删除'
  );
  assert.ok(db.getAlertState(a.id, 'offline'), 'alert_state 无 FK，不应被级联（必须显式清）');
});
