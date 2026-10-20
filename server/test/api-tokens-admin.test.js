'use strict';
// ============================================================
// S2/F5：/admin/api-tokens 管理端点的回归断言。
//
// 锚定行为：
//   - 创建时明文只回显一次（diting_<48hex>），列表接口不回显明文/哈希；
//   - 校验口径明确：name 必填、scope 仅 readonly|admin、
//     agent_ids 必须是已存在节点的字符串数组、expires_in_days 为 1..3650 整数；
//   - 吊销即时生效（下一次请求即 401），重复吊销 404；
//   - 受限 Token（agent_ids 非空）不能列出/签发/吊销 Token，
//     否则可签发一个 agent_ids=[] 的 Token 绕回全节点 —— 提权路径必须 403；
//   - 只读 Token 不能调用管理端点（403 admin required）。
// ============================================================

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'scope-admin-token-0123456789abcdef';
process.env.READONLY_TOKEN = 'scope-readonly-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-api-tokens-admin-test.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const ai = require('../src/ai');

const PROTO = { 'X-Forwarded-Proto': 'https' };
const ADMIN = Object.assign({ 'X-Admin-Token': process.env.ADMIN_TOKEN }, PROTO);

const A = db.createAgent({ name: 'token-admin-a' });
const B = db.createAgent({ name: 'token-admin-b' });

after(async () => {
  alerts.stop();
  ai.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

test('S2/F5: 创建 Token 明文仅回显一次，且立即生效（作用域受限）', async () => {
  const res = await request(app).post('/api/admin/api-tokens').set(ADMIN)
    .send({ name: 'panel-viewer', scope: 'readonly', agent_ids: [A.id] });
  assert.strictEqual(res.status, 200);
  assert.match(res.body.token, /^diting_[0-9a-f]{48}$/, '明文格式应为 diting_<48hex>');
  assert.strictEqual(res.body.scope, 'readonly');
  assert.deepStrictEqual(res.body.agent_ids, [A.id]);
  assert.strictEqual(res.body.expires_at, 0, '未指定有效期应为永不过期');

  const hdr = Object.assign({ 'X-API-Token': res.body.token }, PROTO);
  const list = await request(app).get('/api/agents').set(hdr);
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.body.map((a) => a.id), [A.id], '新 Token 应受 agent_ids 约束');

  const ov = await request(app).get('/api/overview').set(hdr);
  assert.strictEqual(ov.status, 403);
  assert.strictEqual(ov.body.error, 'forbidden_scope');
});

test('S2/F5: 列表接口不回显明文与哈希', async () => {
  const created = await request(app).post('/api/admin/api-tokens').set(ADMIN)
    .send({ name: 'listed', scope: 'readonly', agent_ids: [] });
  assert.strictEqual(created.status, 200);

  const res = await request(app).get('/api/admin/api-tokens').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.list));
  const row = res.body.list.find((t) => t.id === created.body.id);
  assert.ok(row, '新建 Token 应出现在列表中');
  assert.strictEqual(row.token, undefined, '列表不得回显明文');
  assert.strictEqual(row.token_hash, undefined, '列表不得回显哈希');
  assert.ok(!JSON.stringify(res.body).includes(created.body.token), '响应体任何位置都不应含明文');
});

test('S2/F5: 创建参数校验', async () => {
  const cases = [
    [{ scope: 'readonly' }, 'name required'],
    [{ name: 'x', scope: 'root' }, 'invalid_scope'],
    [{ name: 'x', agent_ids: 'agt_1' }, 'invalid agent_ids'],
    [{ name: 'x', agent_ids: ['agt_不存在'] }, 'unknown_agent_id'],
    [{ name: 'x', expires_in_days: 0 }, 'invalid_expires_in_days'],
    [{ name: 'x', expires_in_days: 3651 }, 'invalid_expires_in_days'],
    [{ name: 'x', expires_in_days: 1.5 }, 'invalid_expires_in_days'],
  ];
  for (const [body, error] of cases) {
    const res = await request(app).post('/api/admin/api-tokens').set(ADMIN).send(body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} 应被拒绝`);
    assert.strictEqual(res.body.error, error, `${JSON.stringify(body)} 错误码应为 ${error}`);
  }
  // 合法有效期
  const ok = await request(app).post('/api/admin/api-tokens').set(ADMIN)
    .send({ name: 'expiring', expires_in_days: 7 });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.expires_at > Date.now(), '应写入过期时间');
  assert.strictEqual(ok.body.scope, 'readonly', 'scope 缺省应为最小权限 readonly');
});

test('S2/F5: 吊销即时生效，重复吊销 404', async () => {
  const created = await request(app).post('/api/admin/api-tokens').set(ADMIN)
    .send({ name: 'to-revoke', scope: 'readonly', agent_ids: [B.id] });
  const hdr = Object.assign({ 'X-API-Token': created.body.token }, PROTO);
  assert.strictEqual((await request(app).get('/api/agents').set(hdr)).status, 200, '吊销前应可用');

  const del = await request(app).delete(`/api/admin/api-tokens/${created.body.id}`).set(ADMIN);
  assert.strictEqual(del.status, 200);
  assert.strictEqual((await request(app).get('/api/agents').set(hdr)).status, 401, '吊销后应立即 401');

  const again = await request(app).delete(`/api/admin/api-tokens/${created.body.id}`).set(ADMIN);
  assert.strictEqual(again.status, 404);
});

test('S2/F5: 受限 Token 不得管理 Token（堵住自我提权路径）', async () => {
  // 受限 admin Token 只能通过 db 层构造（API 自身已拒绝受限调用方签发）。
  const scoped = db.createApiToken({ name: 'scoped-admin', scope: 'admin', agentIds: [A.id] });
  const hdr = Object.assign({ 'X-API-Token': scoped.token }, PROTO);

  const list = await request(app).get('/api/admin/api-tokens').set(hdr);
  assert.strictEqual(list.status, 403);
  assert.strictEqual(list.body.error, 'forbidden_scope');

  const create = await request(app).post('/api/admin/api-tokens').set(hdr)
    .send({ name: 'escalate', scope: 'admin', agent_ids: [] });
  assert.strictEqual(create.status, 403);
  assert.strictEqual(create.body.error, 'forbidden_scope');

  const revoke = await request(app).delete('/api/admin/api-tokens/tok_whatever').set(hdr);
  assert.strictEqual(revoke.status, 403);
  assert.strictEqual(revoke.body.error, 'forbidden_scope');
});

test('S2/F5: 只读 Token 不能调用 Token 管理端点', async () => {
  const ro = db.createApiToken({ name: 'plain-ro', scope: 'readonly', agentIds: [] });
  const hdr = Object.assign({ 'X-API-Token': ro.token }, PROTO);
  const res = await request(app).post('/api/admin/api-tokens').set(hdr).send({ name: 'nope' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'admin required');
});
