'use strict';
// ============================================================
// 外部审查复核 Batch E：WS/RPC 资源预算（SEC-02 + SEC-03）。
//   E1  /api/rpc2 每连接令牌桶：突发超额回 rate limited、持续滥用断连、
//       主题级低频流量不受影响、每连接独立桶。
//   E2  批内 heavy 配额：超限整批拒 -32600、恰好上限放行、轻批不受影响、
//       别名继承标记堵绕过、真实数据小批正常。
// 负向对照：git show HEAD:server/server.js + src/compat-rpc.js 旧版跑本文件，
//   E1 全部与 E2 超限用例应失败（旧版无令牌桶/无 heavy 配额）。
// env 必须在 require('../server') 之前设置；WS 连接来自 127.0.0.1，受
//   WS_MAX_PER_MIN=20/WS_MAX_CONCURRENT=5 约束，本文件共 5 连接、顺序复用。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'audit-e-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-audit-e-rpc-budget.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');
const WebSocket = require('ws');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const ai = require('../src/ai');
const rollup = require('../src/rollup');
const { HEAVY_METHODS, MAX_HEAVY_PER_BATCH } = require('../src/compat-rpc');

// 公开端点（rpc2 / WS）须 public_enabled 开启
db.setUiSettings(Object.assign({}, db.getUiSettings(), { public_enabled: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openSockets = new Set();

after(async () => {
  for (const ws of openSockets) { try { ws.terminate(); } catch { /* 已关闭 */ } }
  alerts.stop();
  ai.stop();
  rollup.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// ── WS helpers ──────────────────────────────────────────────
function wsConnect() {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rpc2`);
    openSockets.add(ws);
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } reject(new Error('WS 连接超时')); }, 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
// 收集器：按 id 配对请求响应；rate limited 错误（id=null）单独计数；其余 id=null 视为推送忽略。
function collect(ws) {
  const st = { byId: new Map(), rateLimited: 0, closed: false, closeCode: null };
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.error && m.error.message === 'rate limited') { st.rateLimited++; return; }
    if (m.id != null) { st.byId.set(m.id, m); return; }
  });
  ws.on('close', (code) => { st.closed = true; st.closeCode = code; });
  ws.on('error', () => { /* close 负责收尾 */ });
  return st;
}
const sendRpc = (ws, id, method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
function waitClosed(st, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (st.closed) return resolve();
      if (Date.now() - t0 > timeout) return reject(new Error('等待断连超时'));
      setTimeout(poll, 25);
    })();
  });
}

// ── E2：批内 heavy 配额（HTTP）──────────────────────────────
test('E2 heavy 注册表：重方法标记 + 别名继承 + ping 别名保持轻量', () => {
  assert.strictEqual(MAX_HEAVY_PER_BATCH, 5);
  const canonical = ['common:getRecords', 'public:getRecordsByUUID', 'public:getPingRecords',
    'public:queryMetrics', 'public:getPingMetricStats', 'metrics:query', 'metrics:ping'];
  for (const m of canonical) assert.ok(HEAVY_METHODS.has(m), `${m} 应标记 heavy`);
  // 别名继承（否则主题用无命名空间名即可绕过配额）
  for (const a of ['getRecords', 'getRecordsByUUID', 'getPingRecords', 'queryMetrics', 'getPingMetricStats', 'query']) {
    assert.ok(HEAVY_METHODS.has(a), `别名 ${a} 应继承 heavy`);
  }
  // rpc.ping 先注册占用 ping 别名 → 轻量健康检查不被误标
  assert.ok(!HEAVY_METHODS.has('ping'), 'ping 别名属 rpc.ping，应保持轻量');
  assert.ok(!HEAVY_METHODS.has('common:getNodesLatestStatus'), '状态轮询是轻方法');
  assert.ok(!HEAVY_METHODS.has('rpc.ping'));
});

test('E2 批内 6 heavy 超限 → 整批拒 400 -32600', async () => {
  const batch = Array.from({ length: 6 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'public:queryMetrics', params: {} }));
  const r = await request(app).post('/api/rpc2').send(batch).expect(400);
  assert.strictEqual(r.body.error.code, -32600);
  assert.match(r.body.error.message, /heavy/i);
});

test('E2 恰好 5 heavy 放行 → 200 逐条执行', async () => {
  const batch = Array.from({ length: 5 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'public:queryMetrics', params: {} }));
  const r = await request(app).post('/api/rpc2').send(batch).expect(200);
  assert.ok(Array.isArray(r.body));
  assert.strictEqual(r.body.length, 5);
  for (const item of r.body) assert.deepStrictEqual(item.result.series, [], '空参 queryMetrics 返回空 series');
});

test('E2 轻批不受配额影响：50 light → 200', async () => {
  const batch = Array.from({ length: 50 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'rpc.ping' }));
  const r = await request(app).post('/api/rpc2').send(batch).expect(200);
  assert.ok(Array.isArray(r.body));
  assert.strictEqual(r.body.length, 50);
  assert.ok(r.body.every((x) => x.result === 'pong'));
});

test('E2 混批：5 heavy+45 light 放行；6 heavy+44 light 拒', async () => {
  const light = (n, off) => Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: off + i, method: 'rpc.ping' }));
  const heavy = (n, off) => Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: off + i, method: 'public:queryMetrics', params: {} }));
  const ok = await request(app).post('/api/rpc2').send([...heavy(5, 1), ...light(45, 100)]).expect(200);
  assert.strictEqual(ok.body.length, 50);
  const bad = await request(app).post('/api/rpc2').send([...heavy(6, 1), ...light(44, 100)]).expect(400);
  assert.strictEqual(bad.body.error.code, -32600);
});

test('E2 别名绕过被堵：6×getRecords（无命名空间）→ 400', async () => {
  const batch = Array.from({ length: 6 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'getRecords', params: {} }));
  const r = await request(app).post('/api/rpc2').send(batch).expect(400);
  assert.strictEqual(r.body.error.code, -32600);
});

test('E2 单条 heavy 不受批配额影响 → 200 单对象', async () => {
  const r = await request(app).post('/api/rpc2')
    .send({ jsonrpc: '2.0', id: 1, method: 'public:queryMetrics', params: {} }).expect(200);
  assert.ok(!Array.isArray(r.body));
  assert.deepStrictEqual(r.body.result.series, []);
});

test('E2 真实数据小批 heavy 正常执行（主题兼容回归）', async () => {
  const id = db.createAgent({ name: 'e2-heavy-node' }).id;
  db.insertMetric(id, {
    ts: Date.now() - 60000, cpu: 5, mem_used: 1, mem_total: 2, mem_pct: 50,
    disk_used: 1, disk_total: 2, disk_pct: 50, load1: 0, load5: 0, load15: 0,
    net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0,
    uptime: 10, process_count: 1,
    probes: JSON.stringify({ CM: { ms: 12.5, ok: true, loss: 0 } }),
  });
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'public:getPingRecords', params: { uuid: id, hours: 1 } },
    { jsonrpc: '2.0', id: 2, method: 'metrics:ping', params: { entity_id: id, hours: 1 } },
  ];
  const r = await request(app).post('/api/rpc2').send(batch).expect(200);
  assert.strictEqual(r.body.length, 2);
  assert.ok(Array.isArray(r.body[0].result.records), 'getPingRecords 应返回 records 数组');
  assert.ok(r.body[0].result.count >= 1, '窗口内应有探针记录');
  assert.ok(Array.isArray(r.body[1].result.records), 'metrics:ping 应返回 records 数组');
});

// ── E1：WS 每连接令牌桶 ─────────────────────────────────────
test('E1 突发超桶：超额回 rate limited，连接不断；refill 后恢复', async () => {
  const ws = await wsConnect();
  const st = collect(ws);
  for (let i = 1; i <= 30; i++) sendRpc(ws, i, 'rpc.ping');
  await sleep(400);
  // 桶容量 20：~20 条处理、~10 条被拒（loopback 突发 refill≈0，留 ±1 抖动裕量）
  assert.strictEqual(st.byId.size + st.rateLimited, 30, '30 条都应有下落');
  assert.ok(st.byId.size >= 19 && st.byId.size <= 21, `处理数应≈20，实际 ${st.byId.size}`);
  assert.ok(st.rateLimited >= 9, `被拒数应≈10，实际 ${st.rateLimited}`);
  assert.strictEqual(st.closed, false, '单次突发不应断连');
  // refill 10/s：等 500ms 补 ~5 令牌，再发 1 条应恢复处理
  await sleep(500);
  sendRpc(ws, 999, 'rpc.ping');
  await sleep(250);
  assert.ok(st.byId.has(999), 'refill 后应恢复处理');
  assert.strictEqual(st.byId.get(999).result, 'pong');
  ws.close();
});

test('E1 持续滥用：>100 次违规 → 1008 断连', async () => {
  const ws = await wsConnect();
  const st = collect(ws);
  for (let i = 1; i <= 150; i++) sendRpc(ws, i, 'rpc.ping');
  await waitClosed(st);
  assert.strictEqual(st.closeCode, 1008, `持续滥用应以 1008 断连，实际 ${st.closeCode}`);
  assert.ok(st.rateLimited >= 50, `断连前应已拒绝大量消息，实际 ${st.rateLimited}`);
});

test('E1 主题级低频流量不受影响（5 msg/s × 2s）', async () => {
  const ws = await wsConnect();
  const st = collect(ws);
  // 真实主题最坏 ~1 msg/s（glass 轮询下限 1s）；此处 5 msg/s 已远高于真实流量
  for (let i = 1; i <= 10; i++) { sendRpc(ws, i, 'common:getNodesLatestStatus'); await sleep(200); }
  await sleep(250);
  assert.strictEqual(st.rateLimited, 0, '主题级流量不应触发限流');
  assert.strictEqual(st.byId.size, 10, '10 条轮询都应处理');
  assert.strictEqual(st.closed, false);
  ws.close();
});

test('E1 每连接独立桶：A 耗尽不拖累 B', async () => {
  const a = await wsConnect();
  const b = await wsConnect();
  const sa = collect(a);
  const sb = collect(b);
  for (let i = 1; i <= 25; i++) sendRpc(a, i, 'rpc.ping');
  await sleep(300);
  assert.ok(sa.rateLimited >= 3, 'A 应已被限流');
  sendRpc(b, 1, 'rpc.ping');
  await sleep(250);
  assert.strictEqual(sb.rateLimited, 0, 'B 独立桶不应受 A 影响');
  assert.ok(sb.byId.has(1), 'B 的请求应正常处理');
  assert.strictEqual(sb.byId.get(1).result, 'pong');
  a.close(); b.close();
});