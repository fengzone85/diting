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
const { stats, overThresholdMinutes, diskFullDays, diskTrend, memSlope } = require('./stats');

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

test('diskTrend: 跨度 <2 天 → insufficient（1 天窗口是噪声，不给数字）', () => {
  const r = diskTrend(series(20, (i) => 50 + i / 24), { maxDays: 7 });
  assert.strictEqual(r.note, 'insufficient');
});

test('diskTrend: 已达 90% → reached', () => {
  const r = diskTrend(series(7 * 24, (i) => 85 + i / 24), { maxDays: 7 });
  assert.strictEqual(r.note, 'reached');
});

test('diskTrend: 锯齿上升（含回落段）→ 上界为 null 且区间不倒置', () => {
  // 控制点：升 2 → 落 1 → 再落 0.5 → 大涨 5 → 涨 2 → 涨 2（pp），保证中位斜率为正但 p25 ≤ 0
  const pts = [[0, 60], [28, 62], [56, 61], [84, 60.5], [112, 65.5], [140, 67.5], [168, 69.5]];
  const r = diskTrend(ramp(pts, 7 * 24), { maxDays: 7 });
  assert.strictEqual(r.note, 'ok');
  assert.ok(r.slope_pct_per_day > 0, '中位斜率应为正');
  assert.strictEqual(r.range[1], null, '存在回落时区间上界不设值（报告写「可能更久」）');
  assert.ok(r.range[0] > 0 && (r.range[1] === null || r.range[0] <= r.range[1]), '区间不得倒置');
});

test('diskTrend: 非法/空序列不抛异常', () => {
  assert.strictEqual(diskTrend([], {}).note, 'insufficient');
  assert.strictEqual(diskTrend(null, {}).note, 'insufficient');
  assert.strictEqual(diskTrend([{ ts: 1, pct: null }, { ts: 2, pct: 'x' }], {}).note, 'insufficient');
});
