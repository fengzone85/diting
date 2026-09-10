'use strict';
// ============================================================
// 集成测试：对真实 Express app 发 HTTP 请求（supertest）。
//
// 运行前提（必须在 require('../server') 之前设置）：
//   1. PORT=0            —— 随机端口，避免与 systemd 服务(8081)冲突；dotenv 不会覆盖已设 env
//   2. ADMIN_ALLOW_HTTP=1 —— 绕过 requireProto 的 HTTPS 强制（仅测试环境）
//   3. ADMIN_TOKEN / READONLY_TOKEN —— 测试专用凭证（覆盖 .env 同名项）
//   4. DB_PATH 指向 /tmp 临时库 —— 绝不触碰生产 monitor.db
//
// 回归护栏：本文件锚定三条关键修复的行为——
//   统一错误中间件（400 JSON / 413）、getPublicBaseUrl 显式化（400 server_url_not_configured）、
//   鉴权矩阵（adminOnly / adminOrReadonly / metrics Bearer）。
// ============================================================

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'itest-admin-token-0123456789abcdef';
process.env.READONLY_TOKEN = 'itest-readonly-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-integration-test.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

// 必须在 require('../server') 之前清理上次残留的库文件：
// db.js 在 require 链中就会打开 DB，若之后才 unlink，写入会落到已断链的 inode 上
// 并报「attempt to write a readonly database」。
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

// require 即构建 app 并以随机端口 listen（回调里启动的 alerts/ai 定时器均已 unref）
const { app, server } = require('../server');
const alerts = require('../src/alerts');
const ai = require('../src/ai');

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };
const READONLY = { 'X-Readonly-Token': process.env.READONLY_TOKEN, 'X-Forwarded-Proto': 'https' };

after(async () => {
  // 释放定时器与连接，让测试进程能自然退出（node --test 会等待 event loop 清空）
  alerts.stop();
  ai.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// ---- 公开接口 ----

test('GET /api/public/agents 返回 200 与数组', async () => {
  const res = await request(app).get('/api/public/agents');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body), '应为数组');
});

// ---- 鉴权矩阵 ----

test('POST /api/login 错误 Token → 401 invalid token', async () => {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-Proto', 'https')
    .send({ token: 'wrong-token' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'invalid token');
});

test('POST /api/login 正确 Token → 200 并下发 HttpOnly+SameSite=Strict Cookie', async () => {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-Proto', 'https')
    .send({ token: process.env.ADMIN_TOKEN });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  const cookie = res.headers['set-cookie'].join(';');
  assert.match(cookie, /hm_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test('POST /api/agents 无凭证 → 401（不创建资源）', async () => {
  const res = await request(app)
    .post('/api/agents')
    .set('X-Forwarded-Proto', 'https')
    .send({ name: 'no-auth-agent' });
  assert.strictEqual(res.status, 401);
});

test('GET /api/agents 只读 Token → 200（adminOrReadonly）', async () => {
  const res = await request(app).get('/api/agents').set(READONLY);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /metrics 无 Authorization → 401', async () => {
  const res = await request(app).get('/metrics');
  assert.strictEqual(res.status, 401);
});

// ---- P1-2 回归护栏：服务器地址未显式配置时拒绝生成安装命令 ----

test('POST /api/agents 已登录但未配置服务器地址 → 400 server_url_not_configured', async () => {
  delete process.env.PUBLIC_URL; // getPublicBaseUrl 在请求时读取，require 后清除 .env 可能带入的值
  const res = await request(app)
    .post('/api/agents')
    .set(ADMIN)
    .send({ name: 'itest-agent' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'server_url_not_configured');
});

test('GET /api/agents/:id/commands 未配置服务器地址 → 400 server_url_not_configured', async () => {
  const res = await request(app).get('/api/agents/some-id/commands').set(ADMIN);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'server_url_not_configured');
});

// ---- P0-2 回归护栏：统一错误中间件 ----

test('非法 JSON → 400 application/json（而非默认 HTML 页）', async () => {
  const res = await request(app)
    .post('/api/login')
    .set('Content-Type', 'application/json')
    .set('X-Forwarded-Proto', 'https')
    .send('{bad json');
  assert.strictEqual(res.status, 400);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.strictEqual(res.body.error, 'invalid json');
});

test('超过 16kb 的请求体 → 413 payload too large', async () => {
  const res = await request(app)
    .post('/api/login')
    .set('Content-Type', 'application/json')
    .set('X-Forwarded-Proto', 'https')
    .send(`{"x":"${'a'.repeat(20000)}"}`);
  assert.strictEqual(res.status, 413);
  assert.strictEqual(res.body.error, 'payload too large');
});

// ---- P2-6 回归护栏：注销后旧会话被服务端吊销（而非仅清 Cookie）----

test('logout 后旧 Cookie 立即失效（服务端吊销水位线）', async () => {
  const login = await request(app)
    .post('/api/login')
    .set('X-Forwarded-Proto', 'https')
    .send({ token: process.env.ADMIN_TOKEN });
  assert.strictEqual(login.status, 200);
  const cookie = login.headers['set-cookie'];

  // 登录态可用
  const before = await request(app).get('/api/agents').set('Cookie', cookie).set('X-Forwarded-Proto', 'https');
  assert.strictEqual(before.status, 200);

  // 注销（默认吊销全部会话）
  const out = await request(app).post('/api/logout').set('Cookie', cookie);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.revoked, true);

  // 旧 Cookie 立即 401 —— 这是「注销无效期」修复的核心断言
  const afterLogout = await request(app).get('/api/agents').set('Cookie', cookie).set('X-Forwarded-Proto', 'https');
  assert.strictEqual(afterLogout.status, 401);

  // 重新登录后恢复正常（确认吊销只影响水位线之前的会话）
  const relogin = await request(app)
    .post('/api/login')
    .set('X-Forwarded-Proto', 'https')
    .send({ token: process.env.ADMIN_TOKEN });
  assert.strictEqual(relogin.status, 200);
  const ok = await request(app).get('/api/agents')
    .set('Cookie', relogin.headers['set-cookie'])
    .set('X-Forwarded-Proto', 'https');
  assert.strictEqual(ok.status, 200);
});

// ---- H-01/H-04 回归护栏：公开数据边界 ----

const db = require('../src/db');

// 造一个带业务字段与 probes 的节点，供下面几条断言使用
const bizAgent = db.createAgent('itest-biz-agent');
db.updateAgent(bizAgent.id, {
  name: 'itest-biz-agent', merchant: 'ACME 云', note: '内部备注：勿外传',
  expire_at: '2030-01-01', monthly_quota_gb: 500, price: 99, billing_cycle: 30, currency: '¥'
});
// 直接写全列（insertMetric 是 named 绑定，缺列会以 undefined 触发 SQLite 绑定报错）
db.insertMetric(bizAgent.id, {
  ts: Date.now(),
  cpu: 10, mem_used: 100, mem_total: 1000, mem_pct: 10,
  disk_used: 1, disk_total: 2, disk_pct: 50,
  load1: 0.1, load5: 0.2, load15: 0.3,
  net_rx_rate: 1, net_tx_rate: 2, net_rx_month: 3, net_tx_month: 4,
  uptime: 100, temp: null, swap_used: 0, swap_total: 0, swap_pct: 0,
  disk_r_rate: 0, disk_w_rate: 0,
  // 与 validateReport 落库格式一致：对象而非数组
  probes: JSON.stringify({ '移动': { ms: 12, ok: true, loss: 0 } }),
  disks: '[]'
});

const withUi = async (patch, fn) => {
  const ui = db.getUiSettings();
  db.setUiSettings(Object.assign({}, ui, patch));
  try { return await fn(); } finally { db.setUiSettings(ui); }
};

test('M-01：/api/records/ping 能解析对象格式 probes（此前恒返回空）', async () => {
  const res = await request(app).get('/api/records/ping?hours=1');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.records.length >= 1, 'records 不应为空');
  assert.ok(res.body.tasks.some((t) => t.name === '移动'), 'tasks 应包含「移动」');
  const rec = res.body.records.find((r) => r.value === 12);
  assert.ok(rec, '应存在 value=12 的延迟记录');
});

test('H-04：public_enabled=false 时 /api/v1/nodes 与 /api/public/agents 同步 403', async () => {
  await withUi({ public_enabled: false }, async () => {
    const v1 = await request(app).get('/api/v1/nodes');
    assert.strictEqual(v1.status, 403);
    assert.strictEqual(v1.body.message, 'public page disabled');
    const pub = await request(app).get('/api/public/agents');
    assert.strictEqual(pub.status, 403);
  });
  // 恢复后可用
  const back = await request(app).get('/api/v1/nodes');
  assert.strictEqual(back.status, 200);
});

test('H-01：public_show_business=false 时公开接口不再透出业务字段', async () => {
  // 默认（true）应包含业务字段
  const on = await request(app).get('/api/public/agents');
  const withBiz = on.body.find((a) => a.id === bizAgent.id);
  assert.strictEqual(withBiz.merchant, 'ACME 云');
  assert.strictEqual(withBiz.note, '内部备注：勿外传');

  await withUi({ public_show_business: false }, async () => {
    const pub = await request(app).get('/api/public/agents');
    const a = pub.body.find((x) => x.id === bizAgent.id);
    assert.ok(a, '节点本身仍应可见');
    for (const k of ['merchant', 'expire_at', 'note', 'monthly_quota_gb', 'price', 'billing_cycle', 'currency']) {
      assert.strictEqual(a[k], undefined, `${k} 不应出现在公开响应中`);
    }
    const v1 = await request(app).get('/api/v1/nodes');
    const n = v1.body.data.find((x) => x.uuid === bizAgent.id);
    assert.strictEqual(n.remark, null);
    assert.strictEqual(n.expired_at, null);
    assert.strictEqual(n.traffic_limit, 0);
  });
});
