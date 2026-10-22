'use strict';
// ============================================================
// 管理员 Token 落库（P0）：迁移 / 判据 / 校验 / 重置语义
//
// 覆盖：
//   1. 启动迁移：.env 的 ADMIN_TOKEN 可用且库中无哈希 → 哈希入库，原 Token 照常登录；
//   2. 启动清理：无条件删除历史明文 admin_token_raw 与废弃锁 admin_initialized；
//   3. 判据：/api/setup/status 走 hasAdminToken()；已初始化时 /api/setup/generate → 410；
//   4. env 废弃：库中已有哈希时，运行期改 env 不再生效（不存在多源）；
//   5. 重置语义：换哈希 + 写水位线 + 吊销会话 → 旧 Token 401 / 旧 Cookie 401 / 新 Token 200。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.DB_PATH = '/tmp/diting-admin-token-db-test.db';
process.env.ADMIN_TOKEN = 'initial-admin-token-0123456789abcdef';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

// 先拿到 db（会建表），预置历史残留，再 require server（启动迁移在 require 时执行）
const db = require('../src/db');
db.setConfig('admin_token_raw', 'adm_legacy_plaintext_000000000000');
db.setConfig('admin_initialized', '1');

const { app, server } = require('../server');
const alerts = require('../src/alerts');

const OLD = process.env.ADMIN_TOKEN;
const NEW = 'reset-admin-token-0123456789abcdef';
const PROTO = { 'X-Forwarded-Proto': 'https' };
// loginGuard 按 IP 计失败次数（3 次封 81s）：每个失败用例换一个源 IP，
// 避免前一个用例把后面的用例打成 429。
let xffSeq = 10;
const xff = () => ({ ...PROTO, 'X-Forwarded-For': `198.51.100.${xffSeq++}` });

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

after(async () => {
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

test('启动迁移：env Token 已哈希入库，历史明文与废弃锁被清理', () => {
  assert.equal(db.getAdminTokenHash(), sha256(OLD));
  assert.equal(db.getConfig('admin_token_raw'), null, 'admin_token_raw 应被无条件清理');
  assert.equal(db.getConfig('admin_initialized'), null, 'admin_initialized 应被无条件清理');
});

test('判据：/api/setup/status 走库哈希 → 已初始化', async () => {
  const res = await request(app).get('/api/setup/status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.needs_setup, false);
});

test('判据：已初始化时 /api/setup/generate → 410', async () => {
  const res = await request(app).post('/api/setup/generate').set(PROTO);
  assert.strictEqual(res.status, 410);
  assert.strictEqual(res.body.error, 'already initialized');
});

test('登录：迁移前的原 Token 依然可用（存量无缝升级）', async () => {
  const res = await request(app).post('/api/login').set(xff()).send({ token: OLD });
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers['set-cookie'], '登录成功应下发会话 Cookie');
});

test('校验：错误 Token → 401', async () => {
  const res = await request(app).post('/api/login').set(xff()).send({ token: OLD + 'x' });
  assert.strictEqual(res.status, 401);
});

test('env 废弃：运行期改 process.env.ADMIN_TOKEN 不影响校验', async () => {
  process.env.ADMIN_TOKEN = 'another-admin-token-0123456789abcdef';
  try {
    const ok = await request(app).post('/api/login').set(xff()).send({ token: OLD });
    assert.strictEqual(ok.status, 200, '库哈希仍是 OLD，OLD 应继续可用');
    const bad = await request(app).post('/api/login').set(xff())
      .send({ token: 'another-admin-token-0123456789abcdef' });
    assert.strictEqual(bad.status, 401, '运行期 env 不应成为新来源');
  } finally {
    process.env.ADMIN_TOKEN = OLD;
  }
});

test('重置语义：新 Token 生效、旧 Token 与旧 Cookie 立即失效', async () => {
  // 先拿一个旧会话
  const login = await request(app).post('/api/login').set(xff()).send({ token: OLD });
  const cookie = login.headers['set-cookie'][0].split(';')[0];

  // 模拟 `diting.sh --reset-admin-token` 的落库动作（与脚本 SQL 同语义）
  db.setConfig('session_revoked_before', String(Date.now()));
  db.revokeAllSessionRows();
  db.setAdminTokenHash(sha256(NEW));

  // 旧 Token：401
  const oldTok = await request(app).post('/api/login').set(xff()).send({ token: OLD });
  assert.strictEqual(oldTok.status, 401);
  // 新 Token：200
  const newTok = await request(app).post('/api/login').set(xff()).send({ token: NEW });
  assert.strictEqual(newTok.status, 200);
  // 旧 Cookie：被水位线拦下（verifySession 在 sid 缓存之前调 isRevoked）
  const oldSess = await request(app).get('/api/agents').set(PROTO).set('Cookie', cookie);
  assert.strictEqual(oldSess.status, 401);
});

test('原子抢写：setAdminTokenHashIfAbsent 只成功一次', () => {
  db.clearAdminTokenHash();
  assert.equal(db.setAdminTokenHashIfAbsent(sha256('first-token-0123456789abcdef')), true);
  assert.equal(db.setAdminTokenHashIfAbsent(sha256('second-token-0123456789abcdef')), false);
  assert.equal(db.getAdminTokenHash(), sha256('first-token-0123456789abcdef'));
});
