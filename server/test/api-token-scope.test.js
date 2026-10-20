'use strict';
// ============================================================
// S2/F5 回归：节点白名单 API Token 的作用域边界。
//
// 锚定行为：
//   - 带 agent_ids 的 Token（readonly / admin 均可）只能看/管自己白名单内的节点；
//   - 越权访问单节点面 → 403 forbidden_node（读、写、运维接口一致）；
//   - 全局聚合面（/overview、/agents/sparklines/overview）→ 403 forbidden_scope，
//     不返回任何全局规模/均值；
//   - /agents 列表按白名单裁剪，不外泄其他节点；
//   - agent_ids=[] 的 Token 不受限制（与改造前一致，无副作用）。
//
// 运行前提与 integration.api.test.js 一致：随机端口 + ADMIN_ALLOW_HTTP=1 +
// 独立临时库（绝不触碰生产 monitor.db）。
// ============================================================

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'scope-admin-token-0123456789abcdef';
process.env.READONLY_TOKEN = 'scope-readonly-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-api-token-scope-test.db';

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
const A = db.createAgent({ name: 'scope-node-a' });
const B = db.createAgent({ name: 'scope-node-b' });

// 受限 Token：readonly（只读面）与 admin（写/运维面），agent_ids 均只含 A。
const roScoped = db.createApiToken({ name: 'scoped-ro', scope: 'readonly', agentIds: [A.id] });
const adminScoped = db.createApiToken({ name: 'scoped-admin', scope: 'admin', agentIds: [A.id] });
// 不受限 Token：agent_ids=[]，用于确认改造对普通 Token 无副作用。
const roGlobal = db.createApiToken({ name: 'global-ro', scope: 'readonly', agentIds: [] });

const RO = (t) => Object.assign({ 'X-API-Token': t.token }, PROTO);

after(async () => {
  alerts.stop();
  ai.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

test('S2/F5: 受限 Token 的 /agents 列表只含白名单节点', async () => {
  const res = await request(app).get('/api/agents').set(RO(roScoped));
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body), '应为数组');
  const ids = res.body.map((a) => a.id);
  assert.deepStrictEqual(ids, [A.id], '只应看到白名单内的节点');
});

test('S2/F5: 全局聚合面拒绝受限 Token（forbidden_scope）', async () => {
  for (const path of ['/api/overview', '/api/agents/sparklines/overview']) {
    const res = await request(app).get(path).set(RO(roScoped));
    assert.strictEqual(res.status, 403, `${path} 应对受限 Token 返回 403`);
    assert.strictEqual(res.body.error, 'forbidden_scope', `${path} 错误码应为 forbidden_scope`);
  }
});

test('S2/F5: 单节点读接口校验归属（forbidden_node）', async () => {
  const own = await request(app).get(`/api/agents/${A.id}`).set(RO(roScoped));
  assert.strictEqual(own.status, 200, '自己节点应可读');

  for (const path of [`/api/agents/${B.id}`, `/api/agents/${B.id}/metrics`]) {
    const res = await request(app).get(path).set(RO(roScoped));
    assert.strictEqual(res.status, 403, `${path} 应拒绝越权读`);
    assert.strictEqual(res.body.error, 'forbidden_node', `${path} 错误码应为 forbidden_node`);
  }
});

test('S2/F5: 单节点管理/运维接口校验归属（写操作不得越权）', async () => {
  const hdr = RO(adminScoped);

  const put = await request(app).put(`/api/agents/${B.id}`).set(hdr).send({ note: 'hijack' });
  assert.strictEqual(put.status, 403);
  assert.strictEqual(put.body.error, 'forbidden_node');
  assert.strictEqual((db.getAgent(B.id) || {}).note || '', '', '越权请求不得改动目标节点');

  const del = await request(app).delete(`/api/agents/${B.id}`).set(hdr);
  assert.strictEqual(del.status, 403);
  assert.strictEqual(del.body.error, 'forbidden_node');
  assert.ok(db.getAgent(B.id), '越权删除后节点仍应存在');

  for (const [method, path] of [
    ['post', `/api/agents/${B.id}/approve`],
    ['post', `/api/agents/${B.id}/reset-token`],
    ['post', `/api/agents/${B.id}/renew`],
    ['get', `/api/agents/${B.id}/commands`],
  ]) {
    const res = await request(app)[method](path).set(hdr);
    assert.strictEqual(res.status, 403, `${method.toUpperCase()} ${path} 应拒绝越权`);
    assert.strictEqual(res.body.error, 'forbidden_node', `${path} 错误码应为 forbidden_node`);
  }

  const ownPut = await request(app).put(`/api/agents/${A.id}`).set(hdr).send({ note: 'scoped ok' });
  assert.strictEqual(ownPut.status, 200, '白名单内节点应可管理');
});

test('S2/F5: /agents 之外的全局聚合面同样拒绝受限 Token', async () => {
  for (const path of ['/api/billing', '/api/admin/alert-rules', '/api/ai/usage', '/api/ai/reports', '/api/ai/reports/1']) {
    const res = await request(app).get(path).set(RO(roScoped));
    assert.strictEqual(res.status, 403, `${path} 应对受限 Token 返回 403`);
    assert.strictEqual(res.body.error, 'forbidden_scope', `${path} 错误码应为 forbidden_scope`);
  }
});

test('S2/F5: /agents 之外的节点级接口校验归属', async () => {
  const ro = RO(roScoped);
  const own = await request(app).get(`/api/ai/node-reports?agent_id=${A.id}`).set(ro);
  assert.strictEqual(own.status, 200, '白名单节点的 AI 历史应可读');
  const other = await request(app).get(`/api/ai/node-reports?agent_id=${B.id}`).set(ro);
  assert.strictEqual(other.status, 403);
  assert.strictEqual(other.body.error, 'forbidden_node');

  const hdr = RO(adminScoped);
  for (const [method, path] of [
    ['post', `/api/ai/analyze-node/${B.id}`],
    ['put', `/api/admin/alert-rules/agent/${B.id}`],
    ['delete', `/api/admin/alert-rules/agent/${B.id}`],
  ]) {
    const res = await request(app)[method](path).set(hdr).send({});
    assert.strictEqual(res.status, 403, `${method.toUpperCase()} ${path} 应拒绝越权`);
    assert.strictEqual(res.body.error, 'forbidden_node', `${path} 错误码应为 forbidden_node`);
  }
});

test('S2/F5: 受限 Token 不得触碰全局配置/基础设施写接口', async () => {
  // 节点级 Token 的授权范围是「这几个节点」，与节点无关的全局写操作一律禁止：
  // 否则一个只被授权节点 A 的 Token 仍能关掉全站告警、改系统设置或重建 2FA。
  const hdr = RO(adminScoped);
  const cases = [
    ['post', '/api/agents', { name: 'sneaky' }],
    ['put', '/api/settings', {}],
    ['post', '/api/test-alert', {}],
    ['put', '/api/ai/config', { config: {} }],
    ['post', '/api/admin/notify/channels', { type: 'webhook', name: 'x' }],
    ['put', '/api/admin/alert-rules/group/-', {}],
    ['post', '/api/admin/2fa/setup', {}],
    ['post', '/api/admin/backups/x.db/restore', {}],
  ];
  for (const [method, path, body] of cases) {
    const res = await request(app)[method](path).set(hdr).send(body);
    assert.strictEqual(res.status, 403, `${method.toUpperCase()} ${path} 应拒绝受限 Token`);
    assert.strictEqual(res.body.error, 'forbidden_scope', `${path} 错误码应为 forbidden_scope`);
  }
  // 关键副作用断言：受限 Token 不得真的改掉全局设置。
  const settings = await request(app).get('/api/settings').set(RO(roGlobal));
  assert.strictEqual(settings.status, 200, '不受限 Token 仍可读设置');
});

test('S2/F5: agent_ids=[] 的 Token 不受作用域限制（无回归）', async () => {
  const list = await request(app).get('/api/agents').set(RO(roGlobal));
  assert.strictEqual(list.status, 200);
  const ids = list.body.map((a) => a.id);
  assert.ok(ids.includes(A.id) && ids.includes(B.id), '不受限 Token 应看到全部节点');

  for (const path of ['/api/overview', '/api/billing', '/api/admin/alert-rules', '/api/ai/reports']) {
    const res = await request(app).get(path).set(RO(roGlobal));
    assert.strictEqual(res.status, 200, `不受限 Token 仍可访问 ${path}`);
  }
});
