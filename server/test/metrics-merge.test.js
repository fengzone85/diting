'use strict';
// ============================================================
// S2 第二段：prune 分批 + 小时/明细加权合并读
//
// 锚定行为：
//   1. 水位线分叉：wm 之前走小时行、之后走明细；水位线领先于数据时明细不丢（NOT EXISTS 兜底）
//   2. 权重：小时行 n、明细行 1；均值加权、峰值/末值取 MAX
//   3. until 上界：hour 与 detail 两支都不得越界
//   4. 首末点：since 在明细段时首点与明细一致；长窗口首点保留小时均值、ts 严格单调
//   5. prune：wm 落后时不删未折叠明细；wm 正常时明细保留 DETAIL_DAYS，小时行按 RETENTION_DAYS
//   6. 删除节点显式清 metrics_hour（无 FK）
// ============================================================
process.env.DB_PATH = '/tmp/diting-metrics-merge-test.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const db = require('../src/db');
const rollup = require('../src/rollup');
const merge = require('../src/metrics-merge');

after(() => {
  rollup.stop();
  db.flushTraffic();
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

const H = 3600 * 1000;
const MIN = 60 * 1000;

function metric(agentId, ts, extra) {
  db.insertMetric(agentId, Object.assign({
    ts, cpu: 0, mem_used: 0, mem_total: 0, mem_pct: 0,
    disk_used: 0, disk_total: 0, disk_pct: 0, load1: 0, load5: 0, load15: 0,
    net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0,
    uptime: 0, process_count: 0,
  }, extra || {}));
}

test('S2.5 合并读：小时行按 n 加权、明细行权重 1，峰值取 MAX', () => {
  const id = db.createAgent({ name: 'merge-weight' }).id;
  const h0 = rollup.hourStart(Date.now() - 3 * H);
  // 明细：两行 cpu 10/20 → 折叠成 n=2 avg=15 max=20
  metric(id, h0 + 5 * MIN, { cpu: 10, disk_used: 100, disk_pct: 10 });
  metric(id, h0 + 10 * MIN, { cpu: 20, disk_used: 200, disk_pct: 20 });
  rollup.foldHour(h0);
  assert.strictEqual(db.getMetricsWatermark(), h0 + H);

  // 水位线之后再来两行明细 cpu 40/60，磁盘 300/400
  const now = h0 + 2 * H;
  metric(id, h0 + H + 5 * MIN, { cpu: 40, disk_used: 300, disk_pct: 30 });
  metric(id, h0 + H + 10 * MIN, { cpu: 60, disk_used: 400, disk_pct: 40 });

  // 纯桶聚合（不覆盖首末点）：小时桶 avg=15（n=2）、明细桶 avg=50（两行各权重 1）
  const buckets = merge.weightedRows(db.db, merge.SPARK_SPEC, {
    agentId: id, since: h0, until: now, bucket: H, groupAgent: false,
  });
  assert.strictEqual(buckets.length, 2, `应有 2 个桶，实际 ${buckets.length}`);
  assert.strictEqual(buckets[0].cpu, 15, '小时行按 n 加权');
  assert.strictEqual(buckets[1].cpu, 50, '明细桶为两行均值');

  // 长窗口：首沿在小时段（明细首行落在第 2 桶），首点保留小时均值 150，末点取明细末行
  const rows = db.getMetricsSparklinesOne(id, h0, 2, now);
  assert.strictEqual(rows[0].disk_used, 150, '首点保留小时均值（明细首行不在首桶）');
  assert.strictEqual(rows[rows.length - 1].disk_used, 400, '末点应等于明细末行');
  assert.strictEqual(rows[rows.length - 1].cpu, 60, '末点为最后一条明细行');

  // 明细段窗口（since >= 水位线）：首点必须被明细首行精确覆盖
  const detailWindow = db.getMetricsSparklinesOne(id, h0 + H, 2, now);
  assert.strictEqual(detailWindow[0].disk_used, 300, '首沿在明细段时首点等于明细首行');
});

test('S2.5 合并读：水位线领先于数据时，未折叠的旧明细不得丢失', () => {
  const id = db.createAgent({ name: 'merge-gap' }).id;
  const now = Date.now();
  // 手工把水位线推到 1 小时前（模拟「启动时无数据先占位」/恢复后水位线领先）
  db.setMetricsWatermark(rollup.hourStart(now - H));
  const t = rollup.hourStart(now - 5 * H) + 10 * MIN;
  metric(id, t, { cpu: 77, disk_used: 555 });

  const rows = db.getMetricsSparklinesOne(id, t - H, 10, now);
  assert.ok(rows.length >= 1, '水位线前的未折叠明细必须仍可查到');
  assert.strictEqual(rows[0].cpu, 77);
  assert.strictEqual(rows[0].disk_used, 555);
});

test('S2.5 until 上界：hour 与 detail 两支都不得越界（AI 前窗对比依赖）', () => {
  const id = db.createAgent({ name: 'merge-until' }).id;
  const h0 = rollup.hourStart(Date.now() - 6 * H);
  // 三个小时各一行；折叠前两个小时
  for (let i = 0; i < 3; i++) metric(id, h0 + i * H + 5 * MIN, { cpu: 10 + i });
  rollup.foldHour(h0);
  rollup.foldHour(h0 + H);
  const until = h0 + 2 * H;
  metric(id, h0 + 2 * H + 5 * MIN, { cpu: 99 });

  const rows = db.getMetricsSparklinesOne(id, h0, 10, until);
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(r.ts < until, `不得返回 until 之后的行: ${r.ts} >= ${until}`);
  assert.ok(!rows.some((r) => r.cpu === 99), 'until 之后的明细不得混入');
});

test('S2.5 长窗口首点：since 远早于明细段时，首点保留小时桶值且 ts 严格单调', () => {
  const id = db.createAgent({ name: 'merge-long' }).id;
  const h0 = rollup.hourStart(Date.now() - 20 * 24 * H);
  metric(id, h0 + 5 * MIN, { cpu: 10, disk_used: 100 });
  rollup.foldHour(h0);
  // 明细只保留最近：再插一行最近的
  const recent = Date.now() - 10 * MIN;
  metric(id, recent, { cpu: 50, disk_used: 900 });

  const rows = db.getMetricsSparklinesOne(id, h0, 100, Date.now());
  assert.ok(rows.length >= 2);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].ts > rows[i - 1].ts, 'ts 必须严格单调');
  // 首点仍是首桶（小时均值），不得把中部明细挪到头部
  assert.ok(rows[0].ts >= h0 && rows[0].ts < h0 + H, '首点必须落在首桶内');
  assert.strictEqual(rows[0].cpu, 10);
  assert.strictEqual(rows[rows.length - 1].disk_used, 900, '末点仍取明细');
});

test('S2.5 probes 合并：小时行 n_ok/n_ms 与明细一起加权', () => {
  const id = db.createAgent({ name: 'merge-probes' }).id;
  const h0 = rollup.hourStart(Date.now() - 3 * H);
  metric(id, h0 + 5 * MIN, {
    probes: JSON.stringify({ WEB: { ms: 100, ok: true, loss: 0, type: 'http', code: 200, cert_days: 30 } }),
  });
  metric(id, h0 + 10 * MIN, {
    probes: JSON.stringify({ WEB: { ms: 300, ok: true, loss: 0, type: 'http', code: 200, cert_days: 20 } }),
  });
  rollup.foldHour(h0);
  metric(id, h0 + H + 5 * MIN, {
    probes: JSON.stringify({ WEB: { ms: null, ok: false, loss: 100, type: 'http', code: 500, cert_days: 10 } }),
  });

  const rows = db.getMetricsProbesOne(id, h0, 100);
  const points = rows.map((r) => JSON.parse(r.probes).WEB);
  assert.strictEqual(points.length, 2, `应有 2 个合并点，实际 ${points.length}`);
  // 小时点：ms 均值 200、ok（2/2）、cert_min=20
  assert.strictEqual(points[0].ms, 200);
  assert.strictEqual(points[0].ok, true);
  assert.strictEqual(points[0].cert_days, 20);
  // 明细点：失败样本，ms=null、loss=100
  assert.strictEqual(points[1].ms, null);
  assert.strictEqual(points[1].ok, false);
  assert.strictEqual(points[1].loss, 100);
});

test('S2.4 prune：水位线落后时不删未折叠明细；正常时明细保留 DETAIL_DAYS', () => {
  const now = Date.now();
  const id = db.createAgent({ name: 'merge-prune' }).id;
  // 10 天前、5 天前各一行
  metric(id, now - 10 * 86400000, { cpu: 10 });
  metric(id, now - 5 * 86400000, { cpu: 20 });
  // 默认 RETENTION_DAYS=30 不会删；把水位线压到 20 天前 → 明细上限 = 20 天前，10/5 天前都保留
  db.setMetricsWatermark(now - 20 * 86400000);
  db.prune(30);
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM metrics WHERE agent_id=?').get(id).c, 2, '水位线落后时不得删未折叠明细');

  // 水位线推到 1 小时前 → 明细上限 = now-7d，10 天前那行应被删、5 天前保留
  db.setMetricsWatermark(now - H);
  db.prune(30);
  const left = db.db.prepare('SELECT ts FROM metrics WHERE agent_id=? ORDER BY ts').all(id);
  assert.strictEqual(left.length, 1);
  assert.ok(left[0].ts > now - 6 * 86400000, '5 天前的明细应保留');
});

test('S2.4 prune：小时行按 RETENTION_DAYS 清理；删除节点显式清 metrics_hour', () => {
  const now = Date.now();
  const id = db.createAgent({ name: 'merge-prune-hour' }).id;
  db.db.prepare('INSERT INTO metrics_hour(agent_id, hour_ts, n) VALUES(?,?,?)').run(id, now - 40 * 86400000, 1);
  db.db.prepare('INSERT INTO metrics_hour(agent_id, hour_ts, n) VALUES(?,?,?)').run(id, now - 2 * 86400000, 1);
  db.setMetricsWatermark(now - H);
  db.prune(30);
  const rows = db.db.prepare('SELECT hour_ts FROM metrics_hour WHERE agent_id=?').all(id);
  assert.strictEqual(rows.length, 1, '超保留期的小时行应被删');
  assert.ok(rows[0].hour_ts > now - 3 * 86400000);

  db.deleteAgent(id);
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM metrics_hour WHERE agent_id=?').get(id).c, 0, '删除节点必须清掉小时行');
});

test('S2.5 跨节点合并：每 agent 独立分组，输出含 agent_id', () => {
  const a = db.createAgent({ name: 'merge-all-a' }).id;
  const b = db.createAgent({ name: 'merge-all-b' }).id;
  const h0 = rollup.hourStart(Date.now() - 3 * H);
  metric(a, h0 + 5 * MIN, { cpu: 10 });
  metric(b, h0 + 5 * MIN, { cpu: 30 });
  rollup.foldHour(h0);

  const rows = db.metricsSparklinesAllSampled(h0, 10, null);
  const ids = new Set(rows.map((r) => r.agent_id));
  assert.ok(ids.has(a) && ids.has(b), '两个 agent 都应出现');
  assert.strictEqual(rows.find((r) => r.agent_id === a).cpu, 10);
  assert.strictEqual(rows.find((r) => r.agent_id === b).cpu, 30);
});

test('S2.6 trafficEstimateBucketed：跨水位线仍积分（小时行 + 明细）', () => {
  const id = db.createAgent({ name: 'merge-traffic' }).id;
  const H2 = 3600000;
  const base = Math.floor(Date.now() / H2) * H2;
  // 三行跨 3 小时，先折叠最早一小时
  metric(id, base - 3 * H2, { net_rx_rate: 1000, net_tx_rate: 500 });
  rollup.foldHour(base - 3 * H2);
  metric(id, base - 2 * H2, { net_rx_rate: 1000, net_tx_rate: 500 });
  metric(id, base - 1 * H2, { net_rx_rate: 1000, net_tx_rate: 500 });

  const est = db.trafficEstimateBucketed(id, base - 4 * H2);
  assert.ok(est.rx >= 3600000, `跨水位线仍应积分到至少 1 小时，实际 ${est.rx}`);
});
