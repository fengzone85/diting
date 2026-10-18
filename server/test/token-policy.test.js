'use strict';
// ============================================================
// Token 强度判定（src/token-policy.js）的回归断言
//
// 锚定：
//   - 占位符 change-me-admin-token 与短于 16 位的值一律视为不可用；
//   - tokenIssue 能区分 missing / placeholder / too_short / null（供启动日志分档）；
//   - auth.js / api.js 与 server.js 共用同一实现，不再各自维护副本。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');

const policy = require('../src/token-policy');
const auth = require('../src/auth');

// 读取当前 env 后恢复，避免污染同进程其它测试。
function withAdminToken(value, fn) {
  const prev = process.env.ADMIN_TOKEN;
  if (value === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prev;
  }
}

test('token-policy: 占位符与短值不可用，≥16 位非占位符可用', () => {
  assert.equal(policy.isUsableAdminToken(undefined), false);
  assert.equal(policy.isUsableAdminToken(''), false);
  assert.equal(policy.isUsableAdminToken('change-me-admin-token'), false);
  assert.equal(policy.isUsableAdminToken('a'.repeat(policy.MIN_LEN - 1)), false);
  assert.equal(policy.isUsableAdminToken('a'.repeat(policy.MIN_LEN)), true);
  // 仅长度达标、随机性不足的值仍会通过——这是刻意的「熵下限」而非复杂度策略。
  assert.equal(policy.isUsableAdminToken('passwordpassword'), true);
});

test('token-policy: tokenIssue 四态区分', () => {
  assert.equal(policy.tokenIssue(undefined), 'missing');
  assert.equal(policy.tokenIssue(''), 'missing');
  assert.equal(policy.tokenIssue('change-me-admin-token'), 'placeholder');
  assert.equal(policy.tokenIssue('short'), 'too_short');
  assert.equal(policy.tokenIssue('a'.repeat(policy.MIN_LEN)), null);
});

test('token-policy: getAdminToken 对弱值返回空串（等同未设置）', () => {
  withAdminToken('short', () => {
    assert.equal(policy.getAdminToken(), '');
    assert.equal(auth.getAdminToken(), '');
  });
  withAdminToken('change-me-admin-token', () => {
    assert.equal(policy.getAdminToken(), '');
  });
  withAdminToken('a'.repeat(policy.MIN_LEN), () => {
    assert.equal(policy.getAdminToken(), 'a'.repeat(policy.MIN_LEN));
  });
});

test('token-policy: auth.js 复用同一实现（防阈值漂移）', () => {
  // 同一函数引用：若将来任一处改了阈值而不改另一处，此断言即失败。
  assert.equal(auth.getAdminToken, policy.getAdminToken);
});
