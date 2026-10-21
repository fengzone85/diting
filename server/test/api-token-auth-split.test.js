'use strict';
// ============================================================
// S2/F5 补测：认证分流 P0 回归 + 2FA × API Token
//
// 补齐 IMPLEMENTATION_PLAN_2026-10-19.md F5.4 遗留的两个用例：
//   0. 认证分流 P0 回归：Agent Token 走 X-API-Token 访问管理路由 → 401；
//      Bearer 头在管理路由上不被接受（Bearer 仅用于受控端上报 /metrics）。
//   3. 启用 2FA 时，API Token 访问 adminOnly 端点需 X-TOTP。
//
// 背景（auth.js:144-160 resolveRole）：
//   优先级 签名 Session Cookie > X-API-Token > X-Admin-Token > X-Readonly-Token。
//   X-API-Token 只查 api_tokens 表；Authorization: Bearer 是受控端专用通道。
//   两层从协议层解耦「Agent Token 泄露不能当管理员用」。
//
// 运行前提同 integration.api.test.js：PORT=0 / ADMIN_ALLOW_HTTP=1 /
// 测试专用凭证 / DB_PATH 指向 /tmp 临时库。
// ============================================================

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'authsplit-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-auth-split-test.db';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const totpLib = require('../src/totp');
const alerts = require('../src/alerts');
const ai = require('../src/ai');

// totp 模块的生成函数是具名导出 totp(secret, opts)，包一层便于阅读。
const totpCode = (secret) => totpLib.totp(secret);

const HTTPS = { 'X-Forwarded-Proto': 'https' };

before(() => {
  // 确保 2FA 处于关闭态：本文件前四个用例跑在「未启用 2FA」前提上，
  // 启用 2FA 的用例放最后（DB 为 /tmp 独立库，不影响其它测试文件）。
  db.set2FAEnabled(false);
});

after(async () => {
  alerts.stop();
  ai.stop();
  try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// ---- F5.4-0 认证分流 P0 回归 ------------------------------------------------

test('F5-P0：Agent Token 走 X-API-Token 访问管理路由 → 401', async () => {
  const a = db.createAgent({ name: 'authsplit-agent-token' });
  const res = await request(app)
    .get('/api/agents')
    .set(Object.assign({ 'X-API-Token': a.token }, HTTPS));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'unauthorized');
});

test('F5-P0：Agent Token 走 Authorization: Bearer 访问管理路由 → 401', async () => {
  const a = db.createAgent({ name: 'authsplit-agent-bearer' });
  const res = await request(app)
    .get('/api/agents')
    .set(Object.assign({ Authorization: `Bearer ${a.token}` }, HTTPS));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'unauthorized');
});

test('F5-P0：受控端 Token 只能经 Bearer + X-Agent-ID 用于 /api/report（正对照）', async () => {
  const a = db.createAgent({ name: 'authsplit-report' });
  const res = await request(app)
    .post('/api/report')
    .set(Object.assign({ Authorization: `Bearer ${a.token}`, 'X-Agent-ID': a.id, 'Content-Type': 'application/json' }, HTTPS))
    .send({ cpu: 1.5, mem_total: 1024, mem_used: 512, mem_pct: 50, hostname: 'authsplit-host', os: 'linux' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
});

test('F5-P0：API Token 走 X-API-Token 可访问管理路由（正对照）', async () => {
  const created = db.createApiToken({ name: 'authsplit-positive', scope: 'admin' });
  const res = await request(app)
    .get('/api/admin/sessions')
    .set(Object.assign({ 'X-API-Token': created.token }, HTTPS));
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.list));
});

test('F5-P0：X-API-Token 与 X-Admin-Token 同时出现时，API Token 优先且互不混淆', async () => {
  // 若把 X-Admin-Token 误当 API Token 查表（或反之），本用例会暴露串味。
  const created = db.createApiToken({ name: 'authsplit-both-headers', scope: 'admin' });
  const res = await request(app)
    .get('/api/admin/sessions')
    .set(Object.assign({ 'X-API-Token': created.token, 'X-Admin-Token': process.env.ADMIN_TOKEN }, HTTPS));
  assert.strictEqual(res.status, 200);
  // 再验证单带 X-Admin-Token 也照常可用（两条通道各自独立）
  const res2 = await request(app)
    .get('/api/admin/sessions')
    .set(Object.assign({ 'X-Admin-Token': process.env.ADMIN_TOKEN }, HTTPS));
  assert.strictEqual(res2.status, 200);
});

// ---- F5.4-3 2FA × API Token -------------------------------------------------

test('F5-2FA：启用 2FA 后，API Token 访问 adminOnly 无 X-TOTP → 401 totp required', async () => {
  // 放在最后：本文件之后的用例都在 2FA 关闭态下运行（独立 DB，无跨文件影响）。
  const secret = totpLib.generateSecret();
  db.set2FASecret(secret);
  db.set2FAEnabled(true);
  assert.strictEqual(db.is2FAEnabled(), true);

  const created = db.createApiToken({ name: 'authsplit-2fa', scope: 'admin' });
  const res = await request(app)
    .get('/api/admin/sessions')
    .set(Object.assign({ 'X-API-Token': created.token }, HTTPS));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'totp required');
  assert.strictEqual(res.body.need_totp, true);
});

test('F5-2FA：带正确 X-TOTP 时放行（正对照）', async () => {
  const secret = db.get2FASecret();
  assert.ok(secret, '应能读回上一步设置的 2FA 密钥');
  const created = db.createApiToken({ name: 'authsplit-2fa-pass', scope: 'admin' });
  const code = totpCode(secret);
  const res = await request(app)
    .get('/api/admin/sessions')
    .set(Object.assign({ 'X-API-Token': created.token, 'X-TOTP': code }, HTTPS));
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.list));
});

test('F5-2FA：错误 X-TOTP 被拒（记失败）', async () => {
  const created = db.createApiToken({ name: 'authsplit-2fa-bad', scope: 'admin' });
  const res = await request(app)
    .get('/api/admin/sessions')
    .set(Object.assign({ 'X-API-Token': created.token, 'X-TOTP': '000000' }, HTTPS));
  // 000000 极大概率不匹配；若恰好命中则用例会假阳性，故同时断言不是 200
  assert.notStrictEqual(res.status, 200, '错误 TOTP 不应放行');
  assert.ok([401, 429].includes(res.status), `预期 401 或 429，实际 ${res.status}`);
});

test('F5-2FA：只读作用域 Token 访问 adminOnly → 403 admin required（与 2FA 无关）', async () => {
  const created = db.createApiToken({ name: 'authsplit-2fa-ro', scope: 'readonly' });
  const secret = db.get2FASecret();
  const res = await request(app)
    .get('/api/admin/sessions')
    .set(Object.assign({ 'X-API-Token': created.token, 'X-TOTP': totpCode(secret) }, HTTPS));
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'admin required');
});
