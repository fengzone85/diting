'use strict';
// ============================================================
// S2 第一段：metrics → metrics_hour 折叠（只折叠，不删明细、不改查询路由）
//
// 锚定行为（MONITOR_PARITY_PLAN S2.3/S2.7）：
//   1. AVG/MAX/末行取值正确，n 为明细行数；
//   2. probes 折叠：ms/loss 为 null 不计入对应均值，n/n_ms/n_loss 计数正确；
//      F4 协调字段 n_ok / cert_min / type 一并保留；
//   3. 幂等：重折同一小时结果不变；
//   4. 水位线：初始化到 MIN(ts) 所在整点，runOnce 只折已封口小时并推进；
//   5. 第一段不删除任何明细行（prune 改造属第二段）。
// ============================================================
process.env.DB_PATH = '/tmp/diting-metrics-rollup-test.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const db = require('../src/db');
const rollup = require('../src/rollup');

after(() => {
  rollup.stop();
  db.flushTraffic();
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

const MIN = 60 * 1000;
const H = rollup.hourStart(Date.now() - 3 * 3600 * 1000); // 3 小时前的整点（一定已封口）

function seedAgent(name) {
  return db.createAgent({ name }).id;
}

function metric(agentId, ts, extra) {
  db.insertMetric(agentId, Object.assign({
    ts, cpu: 0, mem_used: 0, mem_total: 0, mem_pct: 0,
    disk_used: 0, disk_total: 0, disk_pct: 0, load1: 0, load5: 0, load15: 0,
    net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0,
    uptime: 0, process_count: 0,
  }, extra || {}));
}

test('S2 折叠：AVG/MAX/小时末行/n 正确', () => {
  const a = seedAgent('rollup-a');
  const b = seedAgent('rollup-b');

  metric(a, H + 0, {
    cpu: 10, mem_pct: 10, mem_used: 100, mem_total: 1000,
    disk_pct: 20, disk_used: 200, disk_total: 1000,
    load1: 1, load5: 2, load15: 3,
    net_rx_rate: 100, net_tx_rate: 50, net_rx_month: 100, net_tx_month: 60,
    temp: null, disk_r_rate: 10, disk_w_rate: 20, process_count: 100, uptime: 1000,
  });
  metric(a, H + 10 * MIN, {
    cpu: 20, mem_pct: 30, mem_used: 300, mem_total: 1000,
    disk_pct: 40, disk_used: 400, disk_total: 1000,
    load1: 4, load5: 5, load15: 6,
    net_rx_rate: 200, net_tx_rate: 100, net_rx_month: 200, net_tx_month: 160,
    temp: 50, disk_r_rate: 30, disk_w_rate: 40, process_count: 200, uptime: 1000,
  });
  metric(a, H + 50 * MIN, {
    cpu: 60, mem_pct: 20, mem_used: 200, mem_total: 2000,
    disk_pct: 30, disk_used: 300, disk_total: 2000,
    load1: 7, load5: 8, load15: 9,
    net_rx_rate: 300, net_tx_rate: 150, net_rx_month: 300, net_tx_month: 260,
    temp: 70, disk_r_rate: 20, disk_w_rate: 10, process_count: 300, uptime: 1000,
  });
  metric(b, H + 20 * MIN, { cpu: 5, mem_pct: 5, net_rx_month: 42, net_tx_month: 24 });

  const out = rollup.foldHour(H);
  assert.strictEqual(out.agents, 0, '无探测目标的节点不产生 probes_hour');

  const row = db.db.prepare('SELECT * FROM metrics_hour WHERE agent_id=? AND hour_ts=?').get(a, H);
  assert.ok(row, '应生成小时行');
  assert.strictEqual(row.n, 3);
  assert.strictEqual(row.cpu_avg, 30);
  assert.strictEqual(row.cpu_max, 60);
  assert.strictEqual(row.mem_pct_avg, 20);
  assert.strictEqual(row.mem_pct_max, 30);
  assert.strictEqual(row.mem_used_avg, 200);
  assert.strictEqual(row.disk_pct_max, 40);
  assert.strictEqual(row.load1_avg, 4);
  assert.strictEqual(row.load1_max, 7);
  assert.strictEqual(row.load5_avg, 5);
  assert.strictEqual(row.load15_avg, 6);
  assert.strictEqual(row.net_rx_rate_avg, 200);
  assert.strictEqual(row.net_rx_rate_max, 300);
  // 计费曲线取小时末行，不是均值
  assert.strictEqual(row.net_rx_month, 300);
  assert.strictEqual(row.net_tx_month, 260);
  // AVG 忽略 NULL：只有 50/70 两行参与
  assert.strictEqual(row.temp_avg, 60);
  assert.strictEqual(row.temp_max, 70);
  assert.strictEqual(row.process_count_max, 300);

  const other = db.db.prepare('SELECT * FROM metrics_hour WHERE agent_id=? AND hour_ts=?').get(b, H);
  assert.strictEqual(other.n, 1);
  assert.strictEqual(other.net_rx_month, 42);
  assert.strictEqual(other.probes_hour, null, '无 probes 的 agent 不写 probes_hour');
});

test('S2 probes 折叠：null 样本不计均值，n/n_ms/n_loss/n_ok/cert_min/type 正确', () => {
  const id = seedAgent('rollup-probes');
  const probes1 = {
    '移动': { ms: 10, ok: true, loss: 0 },
    'WEB': { ms: 100, ok: true, loss: 0, type: 'http', cert_days: 30 },
  };
  const probes2 = {
    '移动': { ms: null, ok: false, loss: 100 },
    'WEB': { ms: 200, ok: false, loss: 100, type: 'http', cert_days: 20 },
  };
  const probes3 = {
    '移动': { ms: 30, ok: true, loss: 0 },
    'WEB': { ms: null, ok: false, loss: 100, type: 'http', cert_days: null },
  };
  metric(id, H + 0, { probes: JSON.stringify(probes1), cpu: 1 });
  metric(id, H + MIN, { probes: JSON.stringify(probes2), cpu: 1 });
  metric(id, H + 2 * MIN, { probes: JSON.stringify(probes3), cpu: 1 });

  rollup.foldHour(H);
  const row = db.db.prepare('SELECT probes_hour FROM metrics_hour WHERE agent_id=? AND hour_ts=?').get(id, H);
  const p = JSON.parse(row.probes_hour);

  assert.strictEqual(p['移动'].n, 3);
  assert.strictEqual(p['移动'].n_ms, 2, 'ms=null 的样本不计入 ms 均值分母');
  assert.strictEqual(p['移动'].ms_avg, 20, '(10+30)/2');
  assert.strictEqual(p['移动'].n_loss, 3);
  assert.strictEqual(p['移动'].loss_avg, 33.3, '(0+100+0)/3');
  assert.strictEqual(p['移动'].n_ok, 2);
  assert.strictEqual(p['移动'].cert_min, null);
  assert.strictEqual(p['移动'].type, 'tcp');

  assert.strictEqual(p['WEB'].n, 3);
  assert.strictEqual(p['WEB'].n_ms, 2);
  assert.strictEqual(p['WEB'].ms_avg, 150);
  assert.strictEqual(p['WEB'].n_loss, 3);
  assert.strictEqual(p['WEB'].loss_avg, 66.7);
  assert.strictEqual(p['WEB'].n_ok, 1);
  assert.strictEqual(p['WEB'].cert_min, 20, '证书取期内最小剩余天数');
  assert.strictEqual(p['WEB'].type, 'http');
});

test('S2 幂等：重折同一小时结果不变，明细行仍在（第一段不删除）', () => {
  const id = seedAgent('rollup-idem');
  metric(id, H + 5 * MIN, { cpu: 42, net_rx_month: 7, probes: JSON.stringify({ x: { ms: 5, ok: true, loss: 0 } }) });
  rollup.foldHour(H);
  const first = db.db.prepare('SELECT * FROM metrics_hour WHERE agent_id=? AND hour_ts=?').get(id, H);
  rollup.foldHour(H);
  const second = db.db.prepare('SELECT * FROM metrics_hour WHERE agent_id=? AND hour_ts=?').get(id, H);
  assert.deepStrictEqual(second, first, '重折结果必须完全一致');

  const detail = db.db.prepare('SELECT COUNT(*) AS c FROM metrics WHERE agent_id=?').get(id);
  assert.strictEqual(detail.c, 1, '第一段（ROLLUP_DELETE=0）不得删除明细');
});

test('S2 水位线：初始化到 MIN(ts) 整点；runOnce 只折已封口小时并推进', async () => {
  const id = seedAgent('rollup-wm');
  // 用当前时间造 3 小时的数据：最后 1 小时尚未封口（LATE=1h1m），只应折到前两小时
  const now = Date.now();
  const h0 = rollup.hourStart(now - 3 * 3600 * 1000);
  for (let i = 0; i < 3; i++) metric(id, h0 + i * 3600 * 1000 + 5 * MIN, { cpu: 10 + i });

  // 已初始化过（前面用例 foldHour），先清掉水位线模拟首次启动
  db.db.prepare("DELETE FROM admin_config WHERE key='metrics_rolled'").run();

  const wm = rollup.ensureWatermark(now);
  assert.strictEqual(wm, h0, '水位线应取 MIN(ts) 所在整点');

  const r1 = await rollup.runOnce({ now });
  assert.ok(r1.folded >= 2, `至少折叠 2 个完整小时，实际 ${r1.folded}`);
  assert.strictEqual(db.getMetricsWatermark(), h0 + r1.folded * 3600 * 1000);

  const r2 = await rollup.runOnce({ now });
  assert.strictEqual(r2.folded, 0, '水位线追上后不应重复折叠');
});

test('S2 detailDays 夹取：默认 7、下限 3、上限 30', () => {
  delete process.env.METRICS_DETAIL_DAYS;
  assert.strictEqual(rollup.detailDays(), 7);
  process.env.METRICS_DETAIL_DAYS = '1';
  assert.strictEqual(rollup.detailDays(), 3);
  process.env.METRICS_DETAIL_DAYS = '90';
  assert.strictEqual(rollup.detailDays(), 30);
  delete process.env.METRICS_DETAIL_DAYS;
});
