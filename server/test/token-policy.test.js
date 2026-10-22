'use strict';
// ============================================================
// Token 强度判定 + 哈希校验口径（src/token-policy.js）的回归断言
//
// P0 变更：库中**只存 sha256 哈希**，旧的 getAdminToken()（读 env 返回明文）已删除。
// 本文件锚定新口径：
//   - 强度判定：占位符 / < 16 位不可用；
//   - hasAdminToken()：库中存在合法 64 位 hex 哈希才算已初始化；
//   - verifyAdminToken()：明文 → sha256 → 与库中哈希恒时比较；脏哈希一律拒绝；
//   - auth.js / server.js / api.js 共用同一实现（防阈值漂移）。
// ============================================================
process.env.DB_PATH = '/tmp/diting-token-policy-test.db';
delete process.env.ADMIN_TOKEN;

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const policy = require('../src/token-policy');
const auth = require('../src/auth');
const db = require('../src/db');

after(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

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

test('token-policy: 未写哈希时 hasAdminToken 为 false，verify 恒 false（env 不再是来源）', () => {
  db.clearAdminTokenHash();
  assert.equal(policy.hasAdminToken(), false);
  // 即使进程 env 里有强 Token，也不再生效（P0：env 仅用于一次性迁移）
  process.env.ADMIN_TOKEN = 'a'.repeat(32);
  try {
    assert.equal(policy.verifyAdminToken('a'.repeat(32)), false);
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
});

test('token-policy: 写入哈希后 hasAdminToken/verifyAdminToken 生效', () => {
  const tok = 'adm_' + 'f'.repeat(48);
  db.setAdminTokenHash(policy.hashAdminToken(tok));
  assert.equal(policy.hasAdminToken(), true);
  assert.equal(policy.verifyAdminToken(tok), true);
  assert.equal(policy.verifyAdminToken(tok + 'x'), false);
  assert.equal(policy.verifyAdminToken(''), false);
  assert.equal(policy.verifyAdminToken(undefined), false);
  assert.equal(policy.verifyAdminToken(12345), false);
});

test('token-policy: 库中哈希非法（脏写/旧明文）时一律视为未初始化', () => {
  for (const bad of ['', 'change-me-admin-token', 'abc', 'A'.repeat(64), 'g'.repeat(64)]) {
    db.setAdminTokenHash(bad);
    assert.equal(policy.hasAdminToken(), false, `脏哈希应被视为未初始化: ${bad.slice(0, 12)}`);
    assert.equal(policy.verifyAdminToken('anything-long-enough-1234'), false);
  }
  db.clearAdminTokenHash();
  assert.equal(policy.hasAdminToken(), false);
});

test('token-policy: auth.js 复用同一实现（防阈值漂移）', () => {
  assert.equal(auth.verifyAdminToken, policy.verifyAdminToken);
});
