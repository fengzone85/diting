'use strict';
// ============================================================
// S2/F9：登录暴力防护（失败计数 + 指数封禁）回归断言
//
// 覆盖（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md §3 F9）：
//   1. 前 1/2 次失败只计数不封禁；第 3 次起封禁，retry_after = fails^4（3^4=81s）；
//   2. 封禁期内 loginGuard() 返回 allowed=false + 剩余秒数；
//   3. 成功登录清零（loginGuardClear）；
//   4. key 维度独立性（不同 IP 互不影响；同 IP 是同一计数单元）；
//   5. count^4 递增（第 4 次失败 → 256s）与 24h 上限；
//   6. 封禁到期后恢复放行；
//   7. 集成：POST /api/login 连错 3 次 → 第 4 次 429 login_blocked + Retry-After 头；
//   8. 集成：成功登录后计数清零（再错 2 次不封禁，第 3 次才封）。
//
// 维度说明：diting 登录是「Admin Token + TOTP」，无 username 概念，故 key 以 IP 为主体。
// 集成用例用 X-Forwarded-For 区分两组 IP（测试进程从回环发请求，默认 trust proxy=loopback
// 会采信 XFF），使两组互不干扰，也不受「每 IP 每 60s 5 次」固定窗口限流影响。
// ============================================================

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'login-guard-admin-token-0123456789ab';
process.env.DB_PATH = '/tmp/diting-login-guard-test.db';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

const {
  loginGuard, loginGuardFail, loginGuardClear,
  LOGIN_GUARD_FAIL_LIMIT, _loginGuardState,
} = require('../src/ratelimit');

// ---- 纯函数单测 ----

test('F9-1 前两次失败只计数不封禁', () => {
  const r1 = loginGuardFail('k-basic');
  assert.equal(r1.banned, false);
  assert.equal(r1.fails, 1);
  const r2 = loginGuardFail('k-basic');
  assert.equal(r2.banned, false);
  assert.equal(r2.fails, 2);
  const st = loginGuard('k-basic');
  assert.equal(st.allowed, true);
  assert.equal(st.fails, 2);
});

test('F9-2 第三次失败起封禁，retry_after = 3^4 = 81s', () => {
  assert.equal(loginGuardFail('k-ban').banned, false, '第 1 次失败不封禁');
  assert.equal(loginGuardFail('k-ban').banned, false, '第 2 次失败不封禁');
  const r3 = loginGuardFail('k-ban');
  assert.equal(r3.banned, true);
  assert.equal(r3.fails, LOGIN_GUARD_FAIL_LIMIT);
  assert.equal(r3.retryAfterSec, 81);
  const st = loginGuard('k-ban');
  assert.equal(st.allowed, false);
  assert.ok(st.retryAfterSec > 0 && st.retryAfterSec <= 81, `retryAfterSec=${st.retryAfterSec}`);
});

test('F9-3 成功登录清零（计数与封禁一并解除）', () => {
  loginGuardFail('k-clear');
  loginGuardFail('k-clear');
  loginGuardFail('k-clear');
  assert.equal(loginGuard('k-clear').allowed, false);
  loginGuardClear('k-clear');
  const st = loginGuard('k-clear');
  assert.equal(st.allowed, true);
  assert.equal(st.fails, 0);
});

test('F9-4 key 维度独立：不同 IP 互不影响', () => {
  loginGuardFail('ip-A');
  loginGuardFail('ip-A');
  loginGuardFail('ip-A');
  assert.equal(loginGuard('ip-A').allowed, false, 'ip-A 应已封禁');
  assert.equal(loginGuard('ip-B').allowed, true, 'ip-B 不应受 ip-A 影响');
  assert.equal(loginGuard('ip-B').fails, 0);
});

test('F9-5 count^4 递增：第 4 次失败 → 256s；上限 24h', () => {
  loginGuardFail('k-esc');
  loginGuardFail('k-esc');
  loginGuardFail('k-esc'); // fails=3 → 81s
  const r4 = loginGuardFail('k-esc'); // fails=4 → 256s
  assert.equal(r4.banned, true);
  assert.equal(r4.retryAfterSec, 256);
  // 上限：fails 足够大时封禁时长封顶 86400s
  const rec = _loginGuardState.get('k-esc');
  rec.fails = 100;
  const r5 = loginGuardFail('k-esc');
  assert.equal(r5.retryAfterSec, 86400);
});

test('F9-6 封禁到期后恢复放行', () => {
  loginGuardFail('k-expire');
  loginGuardFail('k-expire');
  loginGuardFail('k-expire');
  assert.equal(loginGuard('k-expire').allowed, false);
  // 直接把封禁截止时间改到过去，模拟封禁自然到期
  _loginGuardState.get('k-expire').bannedUntil = Date.now() - 1000;
  const st = loginGuard('k-expire');
  assert.equal(st.allowed, true, '封禁到期后应放行');
});

test('F9-7 失败计数超过 TTL 后归零', () => {
  loginGuardFail('k-ttl');
  const rec = _loginGuardState.get('k-ttl');
  rec.expiresAt = Date.now() - 1000; // 计数 TTL 到期
  assert.equal(loginGuard('k-ttl').fails, 0);
  const r = loginGuardFail('k-ttl');
  assert.equal(r.fails, 1, 'TTL 到期后应从 1 重新计数');
});

// ---- 集成测试（真实 Express app） ----

const HTTPS = { 'X-Forwarded-Proto': 'https' };
const IP_A = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.10' };
const IP_B = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.11' };

let app;
let server;
let alerts;
let ai;

before(() => {
  // 必须在 require('../server') 之前清理残留库文件：db.js 在 require 链中就会打开 DB，
  // 若之后才 unlink，写入会落到已断链的 inode 上并报「attempt to write a readonly database」。
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
  }
  const srv = require('../server');
  app = srv.app;
  server = srv.server;
  alerts = require('../src/alerts');
  ai = require('../src/ai');
});

after(async () => {
  if (alerts) alerts.stop();
  if (ai) ai.stop();
  // 释放监听与连接，让测试进程能自然退出（node --test 会等待 event loop 清空）
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
  }
});

test('F9-8 集成：连错 3 次后第 4 次被封（429 + Retry-After）', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await request(app).post('/api/login').set(IP_A).send({ token: 'wrong-token-value' });
    assert.equal(res.status, 401, `第 ${i + 1} 次应 401`);
    assert.equal(res.body.error, 'invalid token');
  }
  const blocked = await request(app).post('/api/login').set(IP_A).send({ token: 'wrong-token-value' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'login_blocked');
  assert.ok(blocked.body.retry_after >= 80 && blocked.body.retry_after <= 81, `retry_after=${blocked.body.retry_after}`);
  const ra = Number(blocked.headers['retry-after']);
  assert.ok(ra >= 80 && ra <= 81, `Retry-After 头=${blocked.headers['retry-after']}`);
});

test('F9-9 集成：成功登录清零计数（再错 2 次不封禁，第 3 次才封）', async () => {
  const ok = await request(app).post('/api/login').set(IP_B).send({ token: process.env.ADMIN_TOKEN });
  assert.equal(ok.status, 200, '正确 token 应登录成功');
  // 成功登录已清零：随后两次失败只计数
  for (let i = 0; i < 2; i++) {
    const res = await request(app).post('/api/login').set(IP_B).send({ token: 'wrong-token-value' });
    assert.equal(res.status, 401, `清零后第 ${i + 1} 次失败应仍为 401（未封禁）`);
  }
  const third = await request(app).post('/api/login').set(IP_B).send({ token: 'wrong-token-value' });
  assert.equal(third.status, 401, '第 3 次失败本身仍返回 401（失败响应）');
  const fourth = await request(app).post('/api/login').set(IP_B).send({ token: 'wrong-token-value' });
  assert.equal(fourth.status, 429, '第 4 次请求应被封禁拦截');
  assert.equal(fourth.body.error, 'login_blocked');
});

test('F9-10 集成：未封禁的 IP 不受另一 IP 封禁影响', async () => {
  const res = await request(app).post('/api/login').set(HTTPS).send({ token: 'wrong-token-value' });
  // 该 IP 未被封禁（第 1 次失败），但固定窗口限流可能已触发 —— 两者都是 429，
  // 故只断言「不是 login_blocked」，避免与固定窗口限流混淆。
  assert.notEqual(res.body && res.body.error, 'login_blocked');
});
