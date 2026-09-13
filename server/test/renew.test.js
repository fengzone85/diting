'use strict';
// PR-1 回归测试（体检 L-1）：续期日期必须走「本地日历日」口径。
//
// TZ 无法在 Node 进程内可靠切换（进程启动后 Date 的时区即固定），
// 故用 child_process 分别以 TZ=Asia/Shanghai 与 TZ=UTC 起子进程调用 nextExpire，
// 锁定「旧实现 toISOString() 在 UTC+8 下早 1 天」这一回归。
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const RENEW = path.join(__dirname, '..', 'src', 'renew.js');
const { nextExpire, fmtLocalDate } = require('../src/renew');

// 在指定 TZ 的子进程中求值，返回 nextExpire 的结果字符串。
function evalInTz(tz, expireAt, nowIso, cycle) {
  const script = `
    const { nextExpire } = require(${JSON.stringify(RENEW)});
    process.stdout.write(nextExpire(${JSON.stringify(expireAt)}, new Date(${JSON.stringify(nowIso)}), ${cycle}));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, { TZ: tz }),
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `子进程失败(TZ=${tz}): ${r.stderr}`);
  return r.stdout.trim();
}

test('L-1: 跨时区结果一致（旧实现在 Asia/Shanghai 下会早 1 天）', () => {
  // expire_at 必须晚于 now 才从 expire_at 起算：now=2026-09-13，取 expire_at=2026-10-01
  // 2026-10-01 + 30 天 = 2026-10-31
  const sh = evalInTz('Asia/Shanghai', '2026-10-01', '2026-09-13T04:00:00Z', 30);
  const utc = evalInTz('UTC', '2026-10-01', '2026-09-13T04:00:00Z', 30);
  assert.strictEqual(sh, '2026-10-31', 'Asia/Shanghai 下应从 expire_at 起算整周期');
  assert.strictEqual(utc, '2026-10-31', 'UTC 下应同值（口径与时区无关）');
  assert.strictEqual(sh, utc, '两种时区必须得到相同日期');
});

test('L-1: 回归锁死——UTC+8 下不得早 1 天（旧实现得 2026-09-30）', () => {
  // 旧实现：new Date('2026-10-01T00:00:00') 在 UTC+8 = 2026-09-30T16:00Z，
  // +30 天后 toISOString() 得 '2026-10-30'（早 1 天）。新实现须得 2026-10-31。
  const got = evalInTz('Asia/Shanghai', '2026-10-01', '2026-09-13T04:00:00Z', 30);
  assert.strictEqual(got, '2026-10-31');
  assert.notStrictEqual(got, '2026-10-30', '旧实现的早 1 天结果必须被拒绝');
});

test('L-1: 连续两次续期无累积漂移', () => {
  const first = evalInTz('Asia/Shanghai', '2026-10-01', '2026-09-13T04:00:00Z', 30);
  const second = evalInTz('Asia/Shanghai', first, '2026-09-13T04:00:00Z', 30);
  const third = evalInTz('Asia/Shanghai', second, '2026-09-13T04:00:00Z', 30);
  assert.strictEqual(first, '2026-10-31');
  assert.strictEqual(second, '2026-11-30');
  assert.strictEqual(third, '2026-12-30');
  // 逐次严格 +30 天，无漂移（旧实现每次会因 UTC 截断而少 1 天）
  assert.strictEqual(new Date(third) - new Date(second), new Date(second) - new Date(first));
});

test('L-1: expire_at 已过期或为空 → 基于 now 当天 + cycle', () => {
  const now = '2026-09-13T04:00:00Z'; // UTC+8 = 2026-09-13 12:00
  assert.strictEqual(evalInTz('Asia/Shanghai', '2026-01-01', now, 30), '2026-10-13');
  assert.strictEqual(evalInTz('Asia/Shanghai', '', now, 30), '2026-10-13');
  assert.strictEqual(evalInTz('Asia/Shanghai', null, now, 30), '2026-10-13');
});

test('L-1: cycle=0（白嫖）→ 返回起点当天，不推进', () => {
  assert.strictEqual(evalInTz('Asia/Shanghai', '2026-10-01', '2026-09-13T04:00:00Z', 0), '2026-10-01');
  assert.strictEqual(evalInTz('Asia/Shanghai', '', '2026-09-13T04:00:00Z', 0), '2026-09-13');
});

test('L-1: 跨月/跨年边界由日历日加法处理', () => {
  // 12-15 + 30 天 = 次年 01-14
  assert.strictEqual(nextExpire('2026-12-15', new Date('2026-12-01T00:00:00Z'), 30), '2027-01-14');
  // 1-31 + 30 天 = 3-02（2026 非闰年，2 月 28 天）
  assert.strictEqual(nextExpire('2026-01-31', new Date('2026-01-01T00:00:00Z'), 30), '2026-03-02');
});

test('L-1: 非法 expire_at / 非法 cycle 不抛错（防御性）', () => {
  const now = new Date('2026-09-13T04:00:00Z');
  assert.strictEqual(nextExpire('not-a-date', now, 30), '2026-10-13');
  assert.strictEqual(nextExpire('2026-10-01', now, NaN), '2026-10-01');
  assert.strictEqual(nextExpire('2026-10-01', now, -5), '2026-10-01');
  assert.strictEqual(nextExpire('2026-10-01', now, '30'), '2026-10-31');
});

test('fmtLocalDate 使用本地时区分量（非 UTC）', () => {
  // 本地构造的 2026-01-01 00:00 必须原样输出，不受 UTC 偏移影响
  assert.strictEqual(fmtLocalDate(new Date(2026, 0, 1)), '2026-01-01');
  assert.strictEqual(fmtLocalDate(new Date(2026, 11, 31)), '2026-12-31');
});
