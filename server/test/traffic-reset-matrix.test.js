'use strict';
process.env.DB_PATH = process.env.DB_PATH || '/tmp/diting-traffic-reset-matrix-test.db';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const traffic = require('../src/traffic');
for (const sfx of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + sfx); } catch {} }

// 独立参考实现：逐月回溯，找第一个 <= now 的重置时刻（不复用被测代码路径）。
// 为什么不用手写断言：手工列举 (now, rotate) 极易把「本月重置日尚未到 ⇒ 回退上月」
// 这条语义写反（第一版就误报实现有 bug）。参考实现独立展开同一语义，再用它遍历
// 大批量组合 —— 既覆盖全矩阵，又不会因人工推导失误而误判实现。
function refLastReset(nowMs, rotate) {
  if (!rotate) return null;
  const local = new Date(nowMs);
  let y = local.getUTCFullYear(), m = local.getUTCMonth();
  for (let i = 0; i < 480; i++) {
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let ry = y, rm = m, rd = rotate;
    if (rotate > dim) {
      const nx = new Date(Date.UTC(y, m + 1, 1));
      ry = nx.getUTCFullYear(); rm = nx.getUTCMonth(); rd = 1;
    }
    const reset = Date.UTC(ry, rm, rd);
    if (reset <= nowMs) return reset;
    const prev = new Date(Date.UTC(y, m, 0));
    y = prev.getUTCFullYear(); m = prev.getUTCMonth();
  }
  return null;
}

test('lastResetDate 全矩阵：rotate 1/28/29/30/31 × 平年/闰年 × 12 月 × 4 时点', () => {
  const tz = 0, rotates = [1, 28, 29, 30, 31];
  let checked = 0;
  for (const y of [2023, 2024, 2025, 2026, 2027]) {
    for (let m = 0; m < 12; m++) {
      const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const nows = [
        Date.UTC(y, m, 1, 0, 0, 0),        // 月初 00:00
        Date.UTC(y, m, 10, 12, 0, 0),      // 月中
        Date.UTC(y, m, dim, 23, 59, 59),   // 月末
        Date.UTC(y, m + 1, 1, 0, 0, 0),    // 次月 1 日 00:00
      ];
      for (const rotate of rotates) {
        for (const now of nows) {
          const got = traffic.lastResetDate(rotate, now, tz);
          const want = refLastReset(now, rotate);
          assert.strictEqual(got, want,
            `rotate=${rotate} now=${new Date(now).toISOString()} 期望 ${new Date(want).toISOString()} 实得 ${got === null ? 'null' : new Date(got).toISOString()}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked >= 1000, `应覆盖大批量组合（实际 ${checked}）`);
});

test('lastResetDate 边界：rotate=0 / 月初 00:00 / 短月顺延链 / 跨年', () => {
  const tz = 0;
  assert.strictEqual(traffic.lastResetDate(0, Date.UTC(2026, 4, 10), tz), null);
  assert.strictEqual(traffic.cycleKeyOf(null, tz), 'cumulative');
  assert.strictEqual(traffic.lastResetDate(1, Date.UTC(2026, 4, 1, 0, 0, 0), tz), Date.UTC(2026, 4, 1));
  assert.strictEqual(traffic.lastResetDate(1, Date.UTC(2026, 4, 1, 0, 0, 0) - 1, tz), Date.UTC(2026, 3, 1));
  // 6 月（30 天）rotate=31：6-31 不存在 → 顺延 7-1，但 7-1 > now → 回退 5 月（31 天）→ 5-31
  assert.strictEqual(traffic.lastResetDate(31, Date.UTC(2026, 5, 15), tz), Date.UTC(2026, 4, 31));
  assert.strictEqual(traffic.lastResetDate(31, Date.UTC(2026, 6, 1, 0, 0, 0), tz), Date.UTC(2026, 6, 1));
  assert.strictEqual(traffic.lastResetDate(31, Date.UTC(2027, 0, 5), tz), Date.UTC(2026, 11, 31));
  assert.strictEqual(traffic.lastResetDate(1, Date.UTC(2027, 0, 5), tz), Date.UTC(2027, 0, 1));
});

test('cycleKeyOf：周期键按本地日（跨月/跨年各自成键；时区偏移生效）', () => {
  const tz = 0;
  assert.strictEqual(traffic.cycleKeyOf(traffic.lastResetDate(1, Date.UTC(2026, 4, 10), tz), tz), '2026-05-01');
  assert.strictEqual(traffic.cycleKeyOf(traffic.lastResetDate(31, Date.UTC(2027, 0, 5), tz), tz), '2026-12-31');
  assert.strictEqual(traffic.cycleKeyOf(Date.UTC(2026, 4, 1, 0, 0, 0), 8), '2026-05-01');
  assert.strictEqual(traffic.cycleKeyOf(Date.UTC(2026, 4, 1, 0, 0, 0), -8), '2026-04-30');
});
