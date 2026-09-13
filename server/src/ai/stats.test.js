'use strict';
// stats.js 纯函数单测（**零 DB 依赖**，不需要 DB_PATH，也不会打开任何库）
//
// 重点：diskTrend 的抗噪回归护栏。历史教训——v2 的「分段中位数」只稳住了分母（斜率），
// 分子仍取末点，注入 +5pp 单点尖峰后估计变化 −30%（与旧的首末两点算法几乎一样糟）。
// 定稿改为「固定近 24h 桶中位」分子后，尖峰注入应几乎无影响。
//
// 运行：cd server && /usr/bin/node --test src/ai/stats.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { stats, overThresholdMinutes, diskFullDays, diskTrend, memSlope, computeSignals, baselineRisk, clampRisk, compareWindows, aggregateProbes, trafficInfo, costInfo } = require('./stats');

const H = 3600000;          // 1h 桶
const DAY = 24 * H;

// 按小时生成桶序列（升序），pct 由 fn(hourIndex) 给出
function series(hours, fn) {
  const end = Date.now();
  const out = [];
  for (let i = hours; i >= 0; i--) out.push({ ts: end - i * H, pct: fn(hours - i) });
  return out;
}

// 通过控制点线性插值生成序列（用于构造「升—落—再升」的锯齿）
function ramp(points, hours) {
  return series(hours, (i) => {
    for (let k = 1; k < points.length; k++) {
      const [h0, v0] = points[k - 1];
      const [h1, v1] = points[k];
      if (i <= h1) return v0 + (v1 - v0) * ((i - h0) / (h1 - h0));
    }
    return points[points.length - 1][1];
  });
}

test('stats: 空数组返回 null 统计量，非法值被剔除', () => {
  assert.deepStrictEqual(stats([]), { count: 0, avg: null, max: null, min: null, p95: null });
  const s = stats([1, null, NaN, 'x', 3, undefined]);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.avg, 2);
  assert.strictEqual(s.max, 3);
  assert.strictEqual(s.min, 1);
});

test('overThresholdMinutes: 按上报间隔把样本数换算成分钟', () => {
  // 10 个样本里 6 个 >= 90，间隔 20s → 6 × 20 / 60 = 2 分钟
  const arr = [95, 95, 90, 80, 91, 92, 93, 70, 95, 60];
  assert.strictEqual(overThresholdMinutes(arr, 90, 20), 2);
  assert.strictEqual(overThresholdMinutes([], 90, 20), 0);
});

test('memSlope: 首末差值（百分点）', () => {
  assert.strictEqual(memSlope([{ mem_pct: 10 }, { mem_pct: 12.5 }]), 2.5);
  assert.strictEqual(memSlope([{ mem_pct: 10 }]), null);
});

test('diskFullDays（旧算法）：末点回落后返回 null', () => {
  // 注意字段名差异：diskFullDays 读的是 metrics 行原始字段 disk_pct（diskTrend 读的是桶序列的 pct）
  const rows = series(24, (i) => 70 + i * 0.1).map((r) => ({ ts: r.ts, disk_pct: r.pct }));
  assert.ok(diskFullDays(rows) > 0, '单调上升应给出天数');
  const dipped = rows.map((r, i) => (i === rows.length - 1 ? { ...r, disk_pct: 60 } : r));
  assert.strictEqual(diskFullDays(dipped), null, '末点低于首点时应放弃外推');
});

test('diskTrend: 平坦序列 → no_growth', () => {
  const r = diskTrend(series(7 * 24, () => 50), { maxDays: 7 });
  assert.strictEqual(r.note, 'no_growth');
});

test('diskTrend: 匀速增长 → 天数与手算一致（±15%）', () => {
  const r = diskTrend(series(7 * 24, (i) => 50 + i / 24), { maxDays: 7 });   // +1pp/天
  assert.strictEqual(r.note, 'ok');
  assert.ok(Math.abs(r.slope_pct_per_day - 1) < 0.2, `斜率应≈1，实际 ${r.slope_pct_per_day}`);
  const expect = (90 - r.level) / 1;
  assert.ok(Math.abs(r.days_to_90 - expect) / expect < 0.15, `天数应≈${expect.toFixed(1)}`);
});

test('diskTrend: 单点尖峰注入后变化 < 25%（抗噪回归护栏）', () => {
  const base = series(7 * 24, (i) => 50 + i / 24);
  const before = diskTrend(base, { maxDays: 7 });
  const spiked = base.map((r, i) => (i === base.length - 1 ? { ...r, pct: r.pct + 5 } : r));
  const after = diskTrend(spiked, { maxDays: 7 });
  const delta = Math.abs(after.days_to_90 - before.days_to_90) / before.days_to_90;
  assert.ok(delta < 0.25, `单点尖峰影响应 <25%，实际 ${(delta * 100).toFixed(1)}%`);
});

test('diskTrend: 末 3 桶尖峰注入后变化 < 25%', () => {
  const base = series(7 * 24, (i) => 50 + i / 24);
  const before = diskTrend(base, { maxDays: 7 });
  const spiked = base.map((r, i) => (i >= base.length - 3 ? { ...r, pct: r.pct + 5 } : r));
  const after = diskTrend(spiked, { maxDays: 7 });
  const delta = Math.abs(after.days_to_90 - before.days_to_90) / before.days_to_90;
  assert.ok(delta < 0.25, `末 3 桶尖峰影响应 <25%，实际 ${(delta * 100).toFixed(1)}%`);
});

test('diskTrend: 新增一个跳变末点时估计不漂移（稳定性回归护栏）', () => {
  // 真机故障形态：最新 1 小时的数据到来改变了段末值，旧实现（段末值 + 单窗口）会在 9 天 ↔ 24 天间跳变，
  // 导致日报与节点分析对同一台机器给出相差 2.5 倍的结论。
  const base = series(10 * 24, (i) => 60 + (i / 24) * 0.8 + (i % 48 < 24 ? 0 : -3));   // 上升 + 日锯齿
  const last = base[base.length - 1];
  const withNew = base.concat([{ ts: last.ts + H, pct: last.pct + 4 }]);
  const a = diskTrend(base, { maxDays: 7 });
  const b = diskTrend(withNew, { maxDays: 7 });
  assert.strictEqual(a.note, 'ok');
  assert.strictEqual(b.note, 'ok');
  const delta = Math.abs(b.days_to_90 - a.days_to_90) / a.days_to_90;
  assert.ok(delta < 0.3, `新增跳变末点后漂移应 <30%，实际 ${(delta * 100).toFixed(1)}%`);
});

test('diskTrend: 跨度 <2 天 → insufficient（1 天窗口是噪声，不给数字）', () => {
  const r = diskTrend(series(20, (i) => 50 + i / 24), { maxDays: 7 });
  assert.strictEqual(r.note, 'insufficient');
});

test('diskTrend: 已达 90% → reached', () => {
  const r = diskTrend(series(7 * 24, (i) => 85 + i / 24), { maxDays: 7 });
  assert.strictEqual(r.note, 'reached');
});

test('diskTrend: 锯齿上升（含回落段）→ 上界为 null 且区间不倒置', () => {
  // 6 个控制点 → 5 个段斜率；构造两段回落，使 p25 ≤ 0（存在回落）但中位斜率仍为正
  const pts = [[0, 60], [28, 64], [56, 58], [84, 62], [112, 56], [140, 70], [168, 76]];
  const r = diskTrend(ramp(pts, 7 * 24), { maxDays: 7 });
  assert.strictEqual(r.note, 'ok');
  assert.ok(r.slope_pct_per_day > 0, `中位斜率应为正，实际 ${r.slope_pct_per_day}`);
  assert.strictEqual(r.range[1], null, '存在回落时区间上界不设值（报告写「可能更久」）');
  assert.ok(r.range[0] > 0 && (r.range[1] === null || r.range[0] <= r.range[1]), '区间不得倒置');
});

test('diskTrend: 非法/空序列不抛异常', () => {
  assert.strictEqual(diskTrend([], {}).note, 'insufficient');
  assert.strictEqual(diskTrend(null, {}).note, 'insufficient');
  assert.strictEqual(diskTrend([{ ts: 1, pct: null }, { ts: 2, pct: 'x' }], {}).note, 'insufficient');
});

// ---- 风险分级（确定性锚点）----

function mkAgent(over) {
  return Object.assign({ online: true, cpu: {}, memory: {}, billing: {} }, over || {});
}

test('computeSignals: 统计离线/沉默/超阈值/临期', () => {
  const s = computeSignals([
    mkAgent({ online: false, stale: true }),
    mkAgent({ online: false }),
    mkAgent({ cpu: { max: 95 } }),
    mkAgent({ billing: { days_until_expire: 5 } })
  ], { cpuAlert: 90, memAlert: 90 });
  assert.strictEqual(s.agents, 4);
  assert.strictEqual(s.offline, 2);
  assert.strictEqual(s.stale, 1);
  assert.strictEqual(s.offline_ratio, 0.5);
  assert.strictEqual(s.over_threshold, 1);
  assert.strictEqual(s.expiring_7d, 1);
});

test('baselineRisk: 按离线占比 / 超阈值数 / 临期数分级', () => {
  const risk = (list) => baselineRisk(computeSignals(list, { cpuAlert: 90, memAlert: 90 }));
  assert.strictEqual(risk([]), 'low');
  assert.strictEqual(risk([mkAgent()]), 'low');
  assert.strictEqual(risk([mkAgent({ online: false }), mkAgent()]), 'medium');
  // 离线占比 >30% → high（10 台中 4 台离线）
  assert.strictEqual(risk(Array.from({ length: 10 }, (_, i) => mkAgent({ online: i >= 4 }))), 'high');
  assert.strictEqual(risk([mkAgent({ cpu: { over_threshold_minutes: 5 } })]), 'medium');
  // 超阈值节点 ≥3 → high
  assert.strictEqual(risk([
    mkAgent({ cpu: { over_threshold_minutes: 5 } }),
    mkAgent({ cpu: { max: 95 } }),
    mkAgent({ memory: { max: 95 } })
  ]), 'high');
  assert.strictEqual(risk([mkAgent({ billing: { days_until_expire: 3 } })]), 'medium');
});

test('clampRisk: 模型判定只能偏离本地 baseline 一级', () => {
  assert.strictEqual(clampRisk('high', 'low'), 'medium', '越两级应收敛到 +1');
  assert.strictEqual(clampRisk('low', 'high'), 'medium', '越两级应收敛到 −1');
  assert.strictEqual(clampRisk('high', 'high'), 'high');
  assert.strictEqual(clampRisk('medium', 'low'), 'medium');
  assert.strictEqual(clampRisk('LOW', 'low'), 'low', '大小写应容错');
  assert.strictEqual(clampRisk('bogus', 'low'), 'bogus', '非法值原样返回，由渲染层兜底');
  assert.strictEqual(clampRisk('high', undefined), 'high', 'baseline 缺失时不干预');
});

// ---- §9 T19：周期对比 ----
function rowOf(ts, { cpu = 10, mem = 50, disk = 60, rx = 1000, load = 1 } = {}) {
  return { ts, cpu, mem_pct: mem, disk_pct: disk, net_rx_rate: rx, load1: load };
}

test('compareWindows：差值符号为「当期 − 前一期」，磁盘用两侧各自末样本', () => {
  const cur = [rowOf(1000, { cpu: 20, mem: 60, disk: 70, rx: 2000, load: 3 }), rowOf(2000, { cpu: 22, mem: 61, disk: 71.5, rx: 2100, load: 3.5 })];
  const prev = [rowOf(500, { cpu: 10, mem: 50, disk: 60, rx: 1000, load: 1 }), rowOf(900, { cpu: 12, mem: 52, disk: 68.5, rx: 1100, load: 1.5 })];
  const r = compareWindows(cur, prev, { periodHours: 24 });
  assert.strictEqual(r.compare_insufficient, false);
  assert.strictEqual(r.compare.window, '24h');
  assert.strictEqual(r.compare.samples_prev, 2);
  assert.strictEqual(r.compare.cpu_avg_delta, 10, '(20+22)/2 − (10+12)/2 = 10');
  assert.strictEqual(r.compare.mem_avg_delta, 9.5);
  assert.strictEqual(r.compare.disk_pct_delta, 3, '末样本 71.5 − 68.5');
  assert.strictEqual(r.compare.net_rx_avg_delta, 1000);
  assert.strictEqual(r.compare.load_avg1_delta, 2);
});

test('compareWindows：前窗样本不足 → compare=null 且标记 insufficient（禁止模型推断趋势）', () => {
  const cur = Array.from({ length: 10 }, (_, i) => rowOf(1000 + i));
  const thin = [rowOf(500)];                       // 1/10 < 20%
  const r1 = compareWindows(cur, thin, { periodHours: 24 });
  assert.strictEqual(r1.compare, null);
  assert.strictEqual(r1.compare_insufficient, true);

  const r2 = compareWindows(cur, [], { periodHours: 24 });
  assert.strictEqual(r2.compare, null);
  assert.strictEqual(r2.compare_insufficient, true);

  const r3 = compareWindows([], [rowOf(500)], { periodHours: 24 });
  assert.strictEqual(r3.compare, null);
  assert.strictEqual(r3.compare_insufficient, true);
});

test('compareWindows：单字段缺失只让该字段为 null，其余照常给出', () => {
  const cur = [rowOf(1000, { disk: 70 })];
  const prev = [{ ts: 500, cpu: 10, mem_pct: 50, net_rx_rate: 1000, load1: 1 }];  // 无 disk_pct
  const r = compareWindows(cur, prev, { periodHours: 24 });
  assert.strictEqual(r.compare.disk_pct_delta, null);
  assert.strictEqual(r.compare.cpu_avg_delta, 0);
});

// ---- §9 T20：探针聚合 ----
function pRow(ts, obj) { return { ts, probes: JSON.stringify(obj) }; }

test('aggregateProbes：按 task 汇总成功率/丢包/延迟，并按样本数排序取前 N', () => {
  const rows = [
    pRow(1, { 移动: { ms: 10, ok: true, loss: 0 }, 联通: { ms: 30, ok: false, loss: 100 } }),
    pRow(2, { 移动: { ms: 20, ok: true, loss: 0 }, 联通: { ms: 40, ok: true, loss: 0 } }),
    pRow(3, { 移动: { ms: 30, ok: false, loss: 50 } })
  ];
  const out = aggregateProbes(rows, { maxTasks: 6 });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].task, '移动', '样本多的 task 优先');
  assert.strictEqual(out[0].samples, 3);
  assert.strictEqual(out[0].ok_rate, 66.7, '2/3 成功');
  assert.strictEqual(out[0].ms_avg, 20);
  assert.strictEqual(out[0].loss_avg, 16.67);
  assert.strictEqual(out[1].task, '联通');
  assert.strictEqual(out[1].ok_rate, 50);

  assert.strictEqual(aggregateProbes(rows, { maxTasks: 1 }).length, 1, 'maxTasks 生效');
  assert.deepStrictEqual(aggregateProbes([], {}), []);
});

test('aggregateProbes：畸形 JSON / 非对象 / 非法字段一律跳过，不抛异常', () => {
  const rows = [
    { ts: 1, probes: '{broken json' },
    { ts: 2, probes: '' },
    { ts: 3, probes: null },
    { ts: 4, probes: '[1,2,3]' },
    pRow(5, { 电信: 'not-an-object' }),
    pRow(6, { 电信: { ms: 'slow', ok: true, loss: null } }),
    pRow(7, { 电信: { ms: 12.5, ok: true, loss: 0 } })
  ];
  const out = aggregateProbes(rows, {});
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].task, '电信');
  assert.strictEqual(out[0].samples, 2, '非对象条目（第 5 行字符串）整条跳过；ms=slow 那条算样本但不计入延迟统计');
  assert.strictEqual(out[0].ok_rate, 100);
  assert.strictEqual(out[0].ms_avg, 12.5);
  assert.strictEqual(out[0].ms_p95, 12.5, '单样本 p95 即该样本');
  assert.strictEqual(out[0].loss_avg, 0);
});

// ---- §9.7 项三：磁盘区间过宽抑制单点天数 ----
function mkSeries(days, fn) {
  const out = [];
  const n = days * 24;
  for (let i = 0; i <= n; i++) out.push({ ts: i * 3600000, pct: fn(i / 24) });
  return out;
}

test('diskTrend: 区间过宽（跨度 ≥5 倍或 ≥30 天）→ 抑制单点天数，只留区间（§9.7 项三）', () => {
  // 平稳线性增长：各窗口斜率一致 → 区间极窄，不触发抑制
  const steady = diskTrend(mkSeries(7, (d) => 50 + 0.3 * d));
  assert.strictEqual(steady.note, 'ok');
  assert.strictEqual(steady.too_wide, false);
  assert.ok(steady.days_to_90 > 0, '平稳增长应给出单点天数');

  // 前慢后快：不同窗口斜率差异巨大（实测区间 [10.7, 644.8]，跨度 60 倍）→ 抑制
  const twoPhase = diskTrend(mkSeries(7, (d) => (d < 4 ? 50 + 0.05 * d : 50.2 + 3 * (d - 4))));
  assert.strictEqual(twoPhase.note, 'ok');
  assert.strictEqual(twoPhase.too_wide, true);
  assert.strictEqual(twoPhase.days_to_90, null, '过宽时不得给单点天数');
  assert.ok(twoPhase.range[0] > 0 && twoPhase.range[1] > twoPhase.range[0] * 5, '区间保留，报告写「区间过宽」');
  // 「可能更久」（上界 null）是另一种情形，不受本规则影响：too_wide 只对双端有限的区间判定
});

// ---- §9.7 项一：月流量与配额 ----
const GB = 1073741824;

test('trafficInfo: GB 换算、配额百分比、距月末天数（时区敏感、确定性）', () => {
  const now = Date.UTC(2026, 2, 15, 12, 0, 0);  // 2026-03-15 12:00 UTC
  const r = trafficInfo({ net_rx_month: 10 * GB, net_tx_month: 2 * GB }, 100, { tzOffsetHours: 8, now });
  assert.strictEqual(r.rx_month_gb, 10);
  assert.strictEqual(r.tx_month_gb, 2);
  assert.strictEqual(r.total_month_gb, 12);
  assert.strictEqual(r.quota_gb, 100);
  assert.strictEqual(r.quota_pct, 12);
  assert.strictEqual(r.days_to_cycle_end, 17, '当地 3-15 20:00 → 距 4-1 还有 16.7 天，向上取整 17');
});

test('trafficInfo: 未设配额不输出 quota_pct；无月累计字段返回 null', () => {
  const r = trafficInfo({ net_rx_month: 1 * GB, net_tx_month: 1 * GB }, 0, { tzOffsetHours: 8, now: Date.UTC(2026, 2, 15) });
  assert.strictEqual(r.quota_gb, 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(r, 'quota_pct'), '无配额不得编造百分比');
  assert.strictEqual(trafficInfo({ cpu: 1 }, 0), null);
  assert.strictEqual(trafficInfo(null, 100), null);
});

// ---- §9.7 项二：成本效率 ----
test('costInfo: 仅付费节点；月成本按周期折算；低利用率为保守规则', () => {
  const s = { cpu: { avg: 3 }, memory: { avg: 30 }, disk: { current_pct: 40 } };
  const paid = { price: 10, billing_cycle: 30, currency: '¥' };

  const c = costInfo(s, paid);
  assert.strictEqual(c.monthly_cost, 10, '月付 10 元 → 10');
  assert.strictEqual(c.currency, '¥');
  assert.strictEqual(c.low_utilization, true, 'cpu 3%<10、mem 30%<40、disk 40%<50');

  assert.strictEqual(costInfo(s, { price: 10, billing_cycle: 180 }).monthly_cost, 1.67, '半年付折算到 30 天');

  // 任一维度不满足 → false
  assert.strictEqual(costInfo({ cpu: { avg: 50 }, memory: { avg: 30 }, disk: { current_pct: 40 } }, paid).low_utilization, false, 'CPU 偏高');
  assert.strictEqual(costInfo({ cpu: { avg: 3 }, memory: { avg: 90 }, disk: { current_pct: 40 } }, paid).low_utilization, false, '内存偏高');
  // 磁盘缺失时按「不构成障碍」处理（纯计算节点磁盘占用无意义）
  assert.strictEqual(costInfo({ cpu: { avg: 3 }, memory: { avg: 30 }, disk: { current_pct: null } }, paid).low_utilization, true);
});

test('costInfo: 白嫖节点（price=0）返回 null，不产出成本效率', () => {
  const s = { cpu: { avg: 3 }, memory: { avg: 30 }, disk: { current_pct: 40 } };
  assert.strictEqual(costInfo(s, { price: 0, billing_cycle: 30 }), null);
  assert.strictEqual(costInfo(s, {}), null);
  assert.strictEqual(costInfo(null, { price: 10 }), null);
});
