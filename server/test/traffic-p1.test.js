'use strict';
// P1 服务端流量口径：validate 可空字段、traffic_state 迁移/累加器、month_rotate 三态。
process.env.DB_PATH = '/tmp/diting-traffic-p1-test.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const db = require('../src/db');
const traffic = require('../src/traffic');
const { validateReport } = require('../src/validate');

after(() => {
  db.flushTraffic();
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

const report = (extra) => validateReport(Object.assign({
  cpu: 1, mem_total: 1, net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0,
}, extra));

test('P1 schema: agents.month_rotate 与 traffic_state 迁移到位', () => {
  const agentCols = db.db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name);
  assert.ok(agentCols.includes('month_rotate'), 'agents 缺 month_rotate 列');
  const trafficCols = db.db.prepare('PRAGMA table_info(traffic_state)').all().map((r) => r.name);
  for (const col of ['agent_id', 'cycle_key', 'cycle_start', 'used_rx', 'used_tx', 'last_rx', 'last_tx', 'last_ts', 'updated_at']) {
    assert.ok(trafficCols.includes(col), `traffic_state 缺 ${col}`);
  }
  const a = db.createAgent({ name: 'traffic-schema' });
  assert.strictEqual(db.getAgent(a.id).month_rotate, null, '新建 agent 默认 month_rotate=NULL');
});

test('month_rotate 三态：显式 0/1–31/NULL 可更新，未携带则保留原值', () => {
  const a = db.createAgent({ name: 'traffic-tri-state' });
  assert.strictEqual(db.getAgent(a.id).month_rotate, null);

  db.updateAgent(a.id, { name: 'traffic-tri-state', month_rotate: 0 });
  assert.strictEqual(db.getAgent(a.id).month_rotate, 0);
  db.updateAgent(a.id, { name: 'traffic-tri-state', month_rotate: 7 });
  assert.strictEqual(db.getAgent(a.id).month_rotate, 7);
  db.updateAgent(a.id, { name: 'traffic-tri-state' });
  assert.strictEqual(db.getAgent(a.id).month_rotate, 7, '未携带 month_rotate 不得清成 NULL');
  db.updateAgent(a.id, { name: 'traffic-tri-state', month_rotate: null });
  assert.strictEqual(db.getAgent(a.id).month_rotate, null, '显式 NULL 表示回到“采纳 agent 上报”');
});

test('validateReport: net_rx/net_tx/month_rotate 可空、限安全整数与 0–31', () => {
  const ok = report({ net_rx: 123, net_tx: '456', month_rotate: '31' });
  assert.strictEqual(ok.net_rx, 123);
  assert.strictEqual(ok.net_tx, 456);
  assert.strictEqual(ok.month_rotate, 31);

  const missing = report({});
  assert.strictEqual(missing.net_rx, null);
  assert.strictEqual(missing.net_tx, null);
  assert.strictEqual(missing.month_rotate, null);

  const over = report({ net_rx: Number.MAX_SAFE_INTEGER + 1, net_tx: Number.MAX_SAFE_INTEGER, month_rotate: 32 });
  assert.strictEqual(over.net_rx, null, '超过 JS 安全整数应按 legacy 处理');
  assert.strictEqual(over.net_tx, Number.MAX_SAFE_INTEGER);
  assert.strictEqual(over.month_rotate, null);

  const negative = report({ month_rotate: -1 });
  assert.strictEqual(negative.month_rotate, null);
});

test('lastResetDate: 31 日短月顺延下月 1 日；闰年/平年 2 月 29 日边界', () => {
  const tz = 0;
  assert.strictEqual(traffic.lastResetDate(31, Date.UTC(2026, 3, 10), tz), Date.UTC(2026, 2, 31), '2026-04-10 的 31 日重置应取 2026-03-31');
  assert.strictEqual(traffic.lastResetDate(29, Date.UTC(2023, 1, 10), tz), Date.UTC(2023, 0, 29), '平年 2 月无 29 日，取 1-29');
  assert.strictEqual(traffic.lastResetDate(29, Date.UTC(2024, 2, 10), tz), Date.UTC(2024, 1, 29), '闰年 2 月有 29 日');
  assert.strictEqual(traffic.lastResetDate(1, Date.UTC(2026, 4, 1, 0, 0, 0), tz), Date.UTC(2026, 4, 1), '月初 00:00 边界归本周期');
});

test('accumulateTraffic: cumulative=绝对计数器；windowed 首报基线、后续 delta、回退截 0', () => {
  const a = db.createAgent({ name: 'traffic-cumulative' });
  const r1 = report({ net_rx: 1000, net_tx: 500, month_rotate: 0 });
  const o1 = db.accumulateTraffic(a.id, r1, Date.now());
  assert.deepStrictEqual({ has_counter: o1.has_counter, rx: o1.used_rx, tx: o1.used_tx }, { has_counter: true, rx: 1000, tx: 500 });
  assert.strictEqual(r1.net_rx_month, 1000, 'metrics 月值应被服务端口径覆盖');

  const r2 = report({ net_rx: 1500, net_tx: 800, month_rotate: 0 });
  const o2 = db.accumulateTraffic(a.id, r2, Date.now());
  assert.deepStrictEqual({ rx: o2.used_rx, tx: o2.used_tx }, { rx: 1500, tx: 800 });
  db.flushTraffic();
  const persisted = db.db.prepare('SELECT * FROM traffic_state WHERE agent_id=?').get(a.id);
  assert.strictEqual(persisted.used_rx, 1500);
  assert.strictEqual(persisted.cycle_key, 'cumulative');

  const b = db.createAgent({ name: 'traffic-windowed' });
  db.updateAgent(b.id, { name: 'traffic-windowed', month_rotate: 1 });
  const w1 = report({ net_rx: 1000, net_tx: 500 });
  const wo1 = db.accumulateTraffic(b.id, w1, Date.now());
  assert.deepStrictEqual({ rx: wo1.used_rx, tx: wo1.used_tx }, { rx: 0, tx: 0 }, 'windowed 新周期首报只设基线');
  const w2 = report({ net_rx: 1600, net_tx: 800 });
  const wo2 = db.accumulateTraffic(b.id, w2, Date.now());
  assert.deepStrictEqual({ rx: wo2.used_rx, tx: wo2.used_tx }, { rx: 600, tx: 300 });
  const w3 = report({ net_rx: 900, net_tx: 400 });
  const wo3 = db.accumulateTraffic(b.id, w3, Date.now());
  assert.deepStrictEqual({ rx: wo3.used_rx, tx: wo3.used_tx }, { rx: 600, tx: 300 }, '计数器回退不得产生负 delta');
});

test('accumulateTraffic: legacy（无 net_rx/net_tx）透传上报月累计并忽略 month_rotate', () => {
  const c = db.createAgent({ name: 'traffic-legacy' });
  db.updateAgent(c.id, { name: 'traffic-legacy', month_rotate: 15 });
  const r = report({ net_rx_month: 777, net_tx_month: 111 });
  const out = db.accumulateTraffic(c.id, r, Date.now());
  assert.strictEqual(out.has_counter, false);
  assert.deepStrictEqual({ rx: out.used_rx, tx: out.used_tx }, { rx: 777, tx: 111 });
  assert.strictEqual(r.net_rx_month, 777, 'legacy 节点不得被服务端口径改写');
});
