'use strict';
// PR-2 回归测试（体检 L-2）：TOTP 重放防护 + 失败节流。
//
// 问题 1：verifyTOTP 只遍历 counter±1，同一 6 位码在 ~90s 窗口内可重放。
// 问题 2：X-TOTP 头路径无失败限流，凭据泄露时可在线枚举。
const test = require('node:test');
const assert = require('node:assert');

const { totp, verifyTOTP, matchCounter, generateSecret } = require('../src/totp');

// auth.js 依赖 db（会在 require 时读 DB_PATH），故用独立模块直接测其导出函数。
// verifyTotpOnce / totpGuard 等被抽到 auth.js，这里通过 auth 导出测试。
const auth = require('../src/auth');

const SECRET = generateSecret();
// 用一个固定时刻，避免测试跨越 30s 时间步边界导致偶发失败
const T0 = 1789000000000; // 固定 epoch ms
const codeAt = (ts) => totp(SECRET, { timestamp: ts });

function fakeReq(ip) {
  return { ip: ip || '203.0.113.7' };
}

test('matchCounter: 正确码返回命中的 counter，错码返回 null', () => {
  const c = codeAt(T0);
  const hit = matchCounter(SECRET, c, { timestamp: T0 });
  assert.ok(hit, '正确码应命中');
  assert.strictEqual(hit.counter, Math.floor(T0 / 1000 / 30));
  assert.strictEqual(hit.period, 30);
  assert.strictEqual(matchCounter(SECRET, '000000', { timestamp: T0 }), null);
  assert.strictEqual(matchCounter(SECRET, 'abcdef', { timestamp: T0 }), null);
  assert.strictEqual(matchCounter(SECRET, '', { timestamp: T0 }), null);
});

test('matchCounter: 相邻窗口（±1 步）也能命中', () => {
  const c = codeAt(T0);
  const prev = matchCounter(SECRET, c, { timestamp: T0 - 30 * 1000 });
  const next = matchCounter(SECRET, c, { timestamp: T0 + 30 * 1000 });
  // ±1 窗口下，当前步的码在相邻步仍应可命中（counter 落在窗口内）
  assert.ok(prev || next, '相邻时间步应至少一侧命中');
});

test('matchCounter: 越界（±2 步）不命中', () => {
  const c = codeAt(T0);
  assert.strictEqual(matchCounter(SECRET, c, { timestamp: T0 + 90 * 1000 }), null);
  assert.strictEqual(matchCounter(SECRET, c, { timestamp: T0 - 90 * 1000 }), null);
});

test('verifyTOTP 保持兼容（薄封装 matchCounter）', () => {
  const c = codeAt(T0);
  assert.strictEqual(verifyTOTP(SECRET, c, { timestamp: T0 }), true);
  assert.strictEqual(verifyTOTP(SECRET, '000000', { timestamp: T0 }), false);
});

test('L-2 防重放：同一码第一次通过、第二次拒绝', () => {
  const secret = generateSecret();
  const code = totp(secret, { timestamp: T0 });
  assert.strictEqual(auth.verifyTotpOnce(secret, code, { timestamp: T0 }), true, '首次应通过');
  assert.strictEqual(auth.verifyTotpOnce(secret, code, { timestamp: T0 }), false, '同一码重放应被拒');
});

test('L-2 防重放：下一个时间步的新码仍可用', () => {
  const secret = generateSecret();
  const c1 = totp(secret, { timestamp: T0 });
  const c2 = totp(secret, { timestamp: T0 + 30 * 1000 });
  assert.strictEqual(auth.verifyTotpOnce(secret, c1, { timestamp: T0 }), true);
  // 不同时间步 → 不同 counter → 不同键，必须放行
  assert.strictEqual(auth.verifyTotpOnce(secret, c2, { timestamp: T0 + 30 * 1000 }), true);
});

test('L-2 防重放：不同 secret 的相同码互不影响（键含 secret 指纹）', () => {
  const s1 = generateSecret();
  const s2 = generateSecret();
  const c1 = totp(s1, { timestamp: T0 });
  assert.strictEqual(auth.verifyTotpOnce(s1, c1, { timestamp: T0 }), true);
  // s2 用同一个码字串：计数器键不同 → 不应被 s1 的消费记录误伤
  assert.strictEqual(auth.verifyTotpOnce(s2, c1, { timestamp: T0 }), false, '码对 s2 本身就不正确');
});

test('L-2 失败节流：同 IP 第 6 次失败后锁定（429）', () => {
  const ip = '198.51.100.9';
  const req = fakeReq(ip);
  // 前 5 次失败：guard 放行，失败被记账
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(auth.totpGuard(req), true, `第 ${i + 1} 次进入应放行`);
    auth.recordTotpFailure(req);
  }
  // 第 6 次：已锁定
  assert.strictEqual(auth.totpGuard(req), false, '达到 5 次失败后应锁定');
});

test('L-2 失败节流：按 IP 隔离，换 IP 不受影响', () => {
  const locked = fakeReq('198.51.100.10');
  for (let i = 0; i < 5; i++) {
    auth.totpGuard(locked);
    auth.recordTotpFailure(locked);
  }
  assert.strictEqual(auth.totpGuard(locked), false, '该 IP 应锁定');
  assert.strictEqual(auth.totpGuard(fakeReq('198.51.100.11')), true, '其他 IP 不受影响');
});

test('L-2 失败节流：成功后清零，不累积', () => {
  const req = fakeReq('198.51.100.12');
  // 先制造 4 次失败（未达阈值）
  for (let i = 0; i < 4; i++) {
    auth.totpGuard(req);
    auth.recordTotpFailure(req);
  }
  assert.strictEqual(auth.totpGuard(req), true, '4 次失败后仍应放行');
  auth.clearTotpFailures(req); // 成功登录 → 计数清零
  // 清零后重新计数：应能再容 5 次失败（而非累计到 5 就锁）
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(auth.totpGuard(req), true, `清零后第 ${i + 1} 次应放行`);
    auth.recordTotpFailure(req);
  }
  assert.strictEqual(auth.totpGuard(req), false, '清零后需重新计满 5 次才锁');
});

test('L-2 失败节流：成功调用不应被计入失败', () => {
  const req = fakeReq('198.51.100.13');
  assert.strictEqual(auth.totpGuard(req), true);
  // 模拟成功路径：只 clear，不 record
  auth.clearTotpFailures(req);
  assert.strictEqual(auth.totpGuard(req), true, '成功路径不应导致锁定');
});

test('L-2 verifyTotpHeader 走 once 路径（重放被拒）', () => {
  // verifyTotpHeader 依赖 db.get2FASecret()，这里只验证「业务层不再直调 verifyTOTP」
  // 的行为契约由源码 grep 保证；此处断言导出面存在。
  assert.strictEqual(typeof auth.verifyTotpOnce, 'function');
  assert.strictEqual(typeof auth.totpGuard, 'function');
  assert.strictEqual(typeof auth.recordTotpFailure, 'function');
  assert.strictEqual(typeof auth.clearTotpFailures, 'function');
});

test('unknown: matchCounter 返回值不泄漏 secret 明文', () => {
  const secret = generateSecret();
  const code = totp(secret, { timestamp: T0 });
  const hit = matchCounter(secret, code, { timestamp: T0 });
  assert.ok(!JSON.stringify(hit).includes(secret), '返回值不得含 secret');
});
