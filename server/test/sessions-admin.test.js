'use strict';
// ============================================================
// S2/F6：登录会话管理闭环 回归断言
//
// 覆盖（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md §3 F6.3）：
//   1. 登录后会话出现在列表里，且能识别「当前会话」；
//   2. 踢出单个会话后，该设备的 cookie 立即 401（不等缓存 TTL）；
//   3. revoke-all（keep_current=true）保留当前会话、其它设备失效；
//   4. revoke-all（keep_current=false）等价全局吊销，旧 cookie 全失效、新登录可用；
//   5. 旧格式（无 sid）cookie 仍放行 —— 升级兼容回归。
//
// 环境：DB_PATH 指向 /tmp 临时库；PORT=0；ADMIN_ALLOW_HTTP=1 + X-Forwarded-Proto 绕过
// requireProto 的 HTTPS 强制（与既有集成测试一致）。
// ============================================================

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'sessions-admin-token-0123456789ab';
process.env.DB_PATH = '/tmp/diting-sessions-admin-test.db';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

const HTTPS = { 'X-Forwarded-Proto': 'https' };
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const COOKIE_NAME = 'hm_session';

let app;
let server;
let alerts;
let ai;

before(() => {
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
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
  }
});

// 登录并返回带 cookie 的 supertest agent。
// 各用例用不同来源 IP：/api/login 有「每 IP 每 60s 5 次」固定窗口限流与 F9 指数封禁，
// 同 IP 连打多次登录会被限流误伤（测试进程从回环发请求，默认 trust proxy=loopback
// 会采信 X-Forwarded-For）。
async function login(ip) {
  const agent = request.agent(app);
  const res = await agent.post('/api/login')
    .set(Object.assign({}, HTTPS, { 'X-Forwarded-For': ip }))
    .send({ token: ADMIN_TOKEN });
  assert.equal(res.status, 200, '登录应成功');
  return agent;
}

test('F6-1 登录后会话出现在列表中，且能识别当前会话', async () => {
  const agent = await login('203.0.113.21');
  const res = await agent.get('/api/admin/sessions').set(HTTPS);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.list), '应返回 list 数组');
  assert.ok(res.body.list.length >= 1, '至少应有 1 条会话');
  const cur = res.body.list.filter((s) => s.current);
  assert.equal(cur.length, 1, '应有且仅有 1 条当前会话');
  assert.ok(/^[0-9a-f]{24}$/.test(cur[0].id), `sid 应为 24 位 hex，实际 ${cur[0].id}`);
  assert.ok(typeof cur[0].created_at === 'number' && typeof cur[0].last_seen === 'number');
});

test('F6-2 踢出单个会话后，该设备 cookie 立即 401', async () => {
  const agent = await login('203.0.113.22');
  const before = await agent.get('/api/admin/sessions').set(HTTPS);
  const cur = before.body.list.find((s) => s.current);
  assert.ok(cur, '应能取到当前会话');

  const del = await agent.delete(`/api/admin/sessions/${cur.id}`).set(HTTPS);
  assert.equal(del.status, 200);

  // 立即再请求：必须 401（缓存已在吊销时失效，不等 5s TTL）
  const after = await agent.get('/api/admin/sessions').set(HTTPS);
  assert.equal(after.status, 401, '被踢出的会话应立即失效');

  // 列表里不应再出现该会话
  const admin = request(app);
  const list = await admin.get('/api/admin/sessions').set(Object.assign({ 'X-Admin-Token': ADMIN_TOKEN }, HTTPS));
  assert.equal(list.status, 200);
  assert.equal(list.body.list.find((s) => s.id === cur.id), undefined, '已吊销会话不应出现在列表');
});

test('F6-2b 踢出不存在 / 非法 id 返回 404 / 400', async () => {
  const admin = request(app);
  const notFound = await admin.delete('/api/admin/sessions/0123456789abcdef01234567').set(Object.assign({ 'X-Admin-Token': ADMIN_TOKEN }, HTTPS));
  assert.equal(notFound.status, 404);
  const bad = await admin.delete('/api/admin/sessions/not-a-valid-sid').set(Object.assign({ 'X-Admin-Token': ADMIN_TOKEN }, HTTPS));
  assert.equal(bad.status, 400);
});

test('F6-3 revoke-all(keep_current=true) 保留当前会话、其它设备失效', async () => {
  const keeper = await login('203.0.113.23');
  const other = await login('203.0.113.24');

  const rev = await keeper.post('/api/admin/sessions/revoke-all').set(HTTPS).send({ keep_current: true });
  assert.equal(rev.status, 200);
  assert.equal(rev.body.kept_current, true);

  // 当前会话仍可用
  const self = await keeper.get('/api/admin/sessions').set(HTTPS);
  assert.equal(self.status, 200, '当前会话应被保留');

  // 其它设备失效
  const gone = await other.get('/api/admin/sessions').set(HTTPS);
  assert.equal(gone.status, 401, '其它设备的会话应失效');
});

test('F6-4 旧格式（无 sid）cookie 仍放行 —— 升级兼容回归', async () => {
  const { signSession } = require('../src/auth');
  const legacy = signSession({ role: 'admin', totp: false, exp: Date.now() + 3600 * 1000 });
  const res = await request(app)
    .get('/api/admin/sessions')
    .set(Object.assign({ Cookie: `${COOKIE_NAME}=${legacy}` }, HTTPS));
  assert.equal(res.status, 200, '无 sid 的旧 cookie 应放行至自然过期');
});

test('F6-5 revoke-all(keep_current=false) 全局吊销，旧 cookie 失效且可重新登录', async () => {
  const agent = await login('203.0.113.25');
  const rev = await agent.post('/api/admin/sessions/revoke-all').set(HTTPS).send({ keep_current: false });
  assert.equal(rev.status, 200);
  assert.equal(rev.body.kept_current, false);

  // 旧 cookie 立即失效
  const gone = await agent.get('/api/admin/sessions').set(HTTPS);
  assert.equal(gone.status, 401, '全局吊销后旧 cookie 应失效');

  // 重新登录可用（换 IP，避开登录限流的每 IP 配额）
  const fresh = request.agent(app);
  const ok = await fresh.post('/api/login')
    .set(Object.assign({}, HTTPS, { 'X-Forwarded-For': '203.0.113.26' }))
    .send({ token: ADMIN_TOKEN });
  assert.equal(ok.status, 200, '全局吊销后新登录应可用');
  const list = await fresh.get('/api/admin/sessions').set(HTTPS);
  assert.equal(list.status, 200);
});

test('F6-6 节点白名单 Token 无权访问会话列表（跨设备敏感信息）', async () => {
  const db = require('../src/db');
  const created = db.createApiToken({ name: 'scoped-session-test', scope: 'admin', agentIds: ['agt_x'] });
  const res = await request(app)
    .get('/api/admin/sessions')
    .set(Object.assign({ 'X-API-Token': created.token }, HTTPS));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_scope');
});
