'use strict';
// ============================================================
// H-2 兼容层契约测试：真实主题请求样本回放
//
// 背景：H-1 把 diting metrics 列 ↔ 兼容字段名的映射收敛到 compat/field-map.js。
// 本测试锁定三个兼容出口（REST / JSON-RPC / metrics）在改造前后的响应字段与取值
// 逐字段一致——字段集、字段名、取值口径都不允许漂移。
//
// 样本来自玻璃拟态设计 v3.x 的实际请求形态（/api/nodes、/api/records/*、
// common:getRecords、public:queryMetrics 等）。用文件库而非 :memory:：
// heavy-db 的 worker 线程会另开连接，:memory: 在 worker 里是空库。
// ============================================================
const DB = `/tmp/diting-compat-contract-${process.pid}.db`;
process.env.DB_PATH = DB;
process.env.THEMES_DIR = `/tmp/diting-compat-contract-themes-${process.pid}`;

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const express = require('express');
const request = require('supertest');

for (const sfx of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(DB + sfx); } catch { /* 不存在则忽略 */ }
}

const db = require('../src/db');
const compat = require('../src/compat');
const fieldMap = require('../src/compat/field-map');
const { COLUMNS } = require('../src/metric-schema');
const heavy = require('../src/heavy-db');

const NOW = Date.now();
const PROBES = JSON.stringify({
  '移动': { ms: 11.5, ok: true, loss: 0, type: 'icmp' },
  '联通': { ms: 24, ok: true, loss: 0, type: 'tcp' },
  'HTTPS': { ms: 88, ok: true, loss: 2.5, type: 'http', code: 200, cert_days: 45 },
  '全丢': { ok: false, loss: 100, type: 'tcp' }
});

const HW = JSON.stringify({
  cpu: { src: 'enum', vendor: 'Intel', tag: '第11代', hidden: false },
  arch: { src: 'custom', text: 'x86_64', hidden: false },
  virt: { src: 'enum', value: 'KVM', hidden: false },
  gpu: { src: 'enum', value: '核显', hidden: false },
  kernel: { src: 'custom', text: '6.1.0-18-amd64', hidden: false }
});

// 主节点：业务字段 + 硬件档案 + 5 条完整指标（含全部真实采集列）
const A = db.createAgent({
  name: 'hk-edge-01', merchant: 'HomeCloud', note: '首尔 BGP',
  price: 88, billing_cycle: 30, currency: '¥', grp: '亚洲',
  country: 'KR', monthly_quota_gb: 500, expire_at: '2027-01-01T00:00:00.000Z',
  hw_profile: HW
}).id;
db.touchAgent(A, 'Debian 12.5', 'hk-edge-01', '1.1.5');
db.setAgentCores(A, 8);

const B = db.createAgent({
  name: 'us-west-02', merchant: '搬瓦工', price: -1, billing_cycle: 0,
  grp: '美洲', country: 'US'
}).id;
db.touchAgent(B, 'Ubuntu 24.04', 'us-west-02', '1.1.5');
db.setAgentCores(B, 2);

for (let i = 5; i >= 1; i--) {
  db.insertMetric(A, {
    ts: NOW - i * 60000,
    cpu: 10 + i, mem_total: 8192, mem_used: 1024 + i * 10, mem_pct: 13,
    swap_total: 2048, swap_used: 128, swap_pct: 6,
    disk_total: 100000, disk_used: 20000 + i, disk_pct: 20,
    load1: 0.5, load5: 0.4, load15: 0.3,
    temp: 45, process_count: 200 + i,
    net_rx_rate: 100 + i, net_tx_rate: 50 + i,
    net_rx_month: 1000000, net_tx_month: 2000000,
    uptime: 3600 + i,
    probes: PROBES
  });
}
for (let i = 3; i >= 1; i--) {
  db.insertMetric(B, {
    ts: NOW - i * 60000,
    cpu: 30, mem_total: 4096, mem_used: 2048,
    disk_total: 50000, disk_used: 10000,
    load1: 1.2, load5: 1.1, load15: 1.0,
    net_rx_rate: 10, net_tx_rate: 20,
    net_rx_month: 100, net_tx_month: 200,
    uptime: 7200, process_count: 90,
    probes: JSON.stringify({ '电信': { ms: 33, ok: true, loss: 0 } })
  });
}

const app = express();
app.use(express.json());
app.use('/api', compat.router);

const get = (url) => request(app).get(url);
const rpc = (method, params) => request(app)
  .post('/api/rpc2')
  .send({ jsonrpc: '2.0', id: 1, method, params })
  .expect(200)
  .then((r) => r.body.result);

const keysOf = (o) => Object.keys(o).sort();

after(() => {
  heavy.stop();
  fs.rmSync(process.env.THEMES_DIR, { recursive: true, force: true });
  for (const sfx of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + sfx); } catch { /* 忽略 */ }
  }
});

// ── 映射表自身：单一事实源的一致性 ────────────────────────────
test('field-map：所有映射目标都是 metrics 真实列', () => {
  const cols = new Set(COLUMNS.map((c) => c.name));
  for (const [compatName, col] of Object.entries(fieldMap.LOAD_FIELD_MAP)) {
    assert.ok(cols.has(col), `LOAD_FIELD_MAP.${compatName} → ${col} 不是 metrics 列`);
  }
  for (const [point, col] of Object.entries(fieldMap.POINT_FIELD_MAP)) {
    assert.ok(cols.has(col), `POINT_FIELD_MAP['${point}'] → ${col} 不是 metrics 列`);
  }
  for (const [compatName, col] of fieldMap.LATEST_STATUS_FIELDS) {
    if (col != null) assert.ok(cols.has(col), `LATEST_STATUS_FIELDS.${compatName} → ${col} 不是 metrics 列`);
  }
  for (const [compatName, col] of fieldMap.NODE_HISTORY_FIELDS) {
    assert.ok(cols.has(col), `NODE_HISTORY_FIELDS.${compatName} → ${col} 不是 metrics 列`);
  }
  for (const [group, fields] of fieldMap.REALTIME_GROUPS) {
    for (const [, col] of fields) assert.ok(cols.has(col), `REALTIME_GROUPS.${group} → ${col} 不是 metrics 列`);
  }
});

test('field-map：swap 不再冒充内存；RECORD_FIELD_MAP 保持历史能力集', () => {
  assert.strictEqual(fieldMap.POINT_FIELD_MAP['swap.used'], 'swap_used');
  assert.strictEqual(fieldMap.POINT_FIELD_MAP['swap.total'], 'swap_total');
  assert.notStrictEqual(fieldMap.POINT_FIELD_MAP['swap.used'], 'mem_used');
  // process.count 只在 metrics 侧支持（common:getRecords 的 metric_keys 分支保持改造前行为）
  assert.strictEqual(fieldMap.POINT_FIELD_MAP['process.count'], 'process_count');
  assert.strictEqual(fieldMap.RECORD_FIELD_MAP['process.count'], undefined);
  assert.strictEqual(fieldMap.RECORD_FIELD_MAP['load.5'], 'load5');
});

// ── REST：节点与实时态 ───────────────────────────────────────
test('REST /api/nodes：node 字段集与硬件/业务口径不变', async () => {
  const { body } = await get('/api/nodes').expect(200);
  const node = body.data.find((n) => n.uuid === A);
  assert.deepStrictEqual(keysOf(node), [
    'arch', 'auto_renewal', 'billing_cycle', 'cpu_cores', 'cpu_name', 'cpu_physical_cores',
    'created_at', 'currency', 'disk_total', 'expired_at', 'gpu_name', 'group', 'hidden',
    'kernel_version', 'mem_total', 'name', 'online', 'os', 'price', 'public_remark',
    'region', 'swap_total', 'tags', 'traffic_limit', 'traffic_limit_type', 'ttl',
    'updated_at', 'uuid', 'virtualization', 'weight'
  ]);
  assert.strictEqual(node.cpu_name, 'Intel 第11代');
  assert.strictEqual(node.arch, 'x86_64');
  assert.strictEqual(node.virtualization, 'KVM');
  assert.strictEqual(node.gpu_name, '核显');
  assert.strictEqual(node.kernel_version, '6.1.0-18-amd64');
  assert.strictEqual(node.mem_total, 8192);
  assert.strictEqual(node.swap_total, 2048);
  assert.strictEqual(node.disk_total, 100000);
  assert.strictEqual(node.price, 88);
  assert.strictEqual(node.tags, 'HomeCloud');
  assert.strictEqual(node.group, '亚洲');
});

test('REST /api/recent/:uuid：嵌套实时结构字段与取值不变', async () => {
  const { body } = await get(`/api/recent/${A}`).expect(200);
  const rt = body.data[0];
  assert.deepStrictEqual(keysOf(rt), [
    'connections', 'cpu', 'disk', 'load', 'message', 'network', 'online',
    'process', 'ram', 'swap', 'ttl', 'updated_at', 'uptime'
  ]);
  assert.deepStrictEqual(rt.cpu, { usage: 11 });
  assert.deepStrictEqual(rt.ram, { total: 8192, used: 1034 });
  assert.deepStrictEqual(rt.swap, { total: 2048, used: 128 });
  assert.deepStrictEqual(rt.load, { load1: 0.5, load5: 0.4, load15: 0.3 });
  assert.deepStrictEqual(rt.disk, { total: 100000, used: 20001 });
  assert.deepStrictEqual(rt.network, { up: 51, down: 101, totalUp: 2000000, totalDown: 1000000 });
  assert.deepStrictEqual(rt.connections, { tcp: 0, udp: 0 });
  assert.strictEqual(rt.process, 201);
  assert.strictEqual(rt.uptime, 3601);
});

// ── REST：历史记录与 load_type 投影 ─────────────────────────
test('REST /api/records/load：完整记录字段集与取值不变', async () => {
  const { body } = await get(`/api/records/load?uuid=${A}&hours=1&max_count=50`).expect(200);
  const rec = body.data.records[body.data.records.length - 1];
  assert.deepStrictEqual(keysOf(rec), [
    'client', 'connections', 'cpu', 'disk', 'disk_total', 'load', 'net_in', 'net_out',
    'net_total_down', 'net_total_up', 'process', 'ram', 'ram_total', 'swap', 'swap_total',
    'temp', 'time'
  ]);
  assert.deepStrictEqual(
    [rec.cpu, rec.ram, rec.ram_total, rec.swap, rec.swap_total, rec.load, rec.disk,
      rec.disk_total, rec.net_in, rec.net_out, rec.net_total_up, rec.net_total_down,
      rec.temp, rec.process, rec.connections],
    [11, 1034, 8192, 128, 2048, 0.5, 20001, 100000, 101, 51, 2000000, 1000000, 45, 201, 0]
  );
});

test('REST /api/records/load：load_type 投影白名单与改造前一致', async () => {
  const cpu = (await get(`/api/records/load?uuid=${A}&hours=1&load_type=cpu`).expect(200)).body.data;
  assert.strictEqual(cpu.load_type, 'cpu');
  assert.deepStrictEqual(keysOf(cpu.records[0]), ['client', 'cpu', 'time']);

  const conn = (await get(`/api/records/load?uuid=${A}&hours=1&load_type=connections`).expect(200)).body.data;
  assert.strictEqual(conn.load_type, 'connections');
  assert.deepStrictEqual(keysOf(conn.records[0]), ['client', 'connections', 'time']);
  assert.strictEqual(conn.records[0].connections, 0);

  // gpu/all 不在 REST 白名单内：保持改造前「视为非法、不投影」的行为
  const gpu = (await get(`/api/records/load?uuid=${A}&hours=1&load_type=gpu`).expect(200)).body.data;
  assert.strictEqual(gpu.load_type, undefined);
  assert.ok('ram' in gpu.records[0], '非法 load_type 不应投影');
});

test('REST /api/records/ping：任务/记录字段与 task_id 口径不变', async () => {
  const { body } = await get(`/api/records/ping?uuid=${A}&hours=1&max_count=50`).expect(200);
  const data = body.data;
  assert.deepStrictEqual(keysOf(data.tasks[0]), ['cert_days', 'code', 'id', 'interval', 'loss', 'name', 'type']);
  const http = data.tasks.find((t) => t.name === 'HTTPS');
  assert.strictEqual(http.type, 'http');
  assert.strictEqual(http.code, 200);
  assert.strictEqual(http.cert_days, 45);
  const rec = data.records[0];
  assert.deepStrictEqual(keysOf(rec), ['client', 'task_id', 'time', 'value']);
  assert.strictEqual(rec.client, A);
});

test('REST /api/node/:uuid：详情历史字段集与取值不变', async () => {
  const { body } = await get(`/api/node/${A}?range=1h`).expect(200);
  const h = body.data.history[body.data.history.length - 1];
  assert.deepStrictEqual(keysOf(h), [
    'cpu', 'created_at', 'disk', 'disk_total', 'down', 'load1', 'ram', 'ram_total',
    'swap', 'swap_total', 'temp', 'up'
  ]);
  assert.deepStrictEqual(
    [h.cpu, h.ram, h.ram_total, h.swap, h.swap_total, h.disk, h.disk_total, h.up, h.down, h.load1, h.temp],
    [11, 1034, 8192, 128, 2048, 20001, 100000, 51, 101, 0.5, 45]
  );
  assert.strictEqual(body.data.node.uuid, A);
});

// ── JSON-RPC：节点实时投影 ──────────────────────────────────
test('RPC common:getNodesLatestStatus：扁平状态字段集不变', async () => {
  const all = await rpc('common:getNodesLatestStatus', {});
  assert.deepStrictEqual(keysOf(all[A]), [
    'client', 'connections', 'connections_udp', 'cpu', 'disk', 'disk_total', 'gpu',
    'load', 'load15', 'load5', 'net_in', 'net_out', 'net_total_down', 'net_total_up',
    'online', 'process', 'ram', 'ram_total', 'swap', 'swap_total', 'temp', 'time',
    'ttl', 'uptime'
  ]);
  const s = all[A];
  assert.deepStrictEqual(
    [s.cpu, s.ram, s.ram_total, s.swap, s.swap_total, s.load, s.load5, s.load15,
      s.temp, s.disk, s.disk_total, s.net_in, s.net_out, s.process, s.gpu,
      s.connections, s.connections_udp, s.uptime],
    [11, 1034, 8192, 128, 2048, 0.5, 0.4, 0.3, 45, 20001, 100000, 101, 51, 201, 0, 0, 0, 3601]
  );
  // 过滤参数只影响键集，不改变字段口径
  const one = await rpc('common:getNodesLatestStatus', { uuid: A });
  assert.deepStrictEqual(Object.keys(one), [A]);
});

test('RPC common:getNodeRecentStatus：官方扁平记录（含 null 三态）不变', async () => {
  const r = await rpc('common:getNodeRecentStatus', { uuid: A });
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(keysOf(r.records[0]), [
    'client', 'connections', 'connections_udp', 'cpu', 'disk', 'disk_total', 'load',
    'net_in', 'net_out', 'net_total_down', 'net_total_up', 'process', 'ram', 'ram_total',
    'swap', 'swap_total', 'temp', 'time', 'uptime'
  ]);
  // 扁平记录直接取实时行：uptime 有真实值；cpu/ram 口径与 REST 一致
  assert.strictEqual(r.records[0].uptime, 3601);
  assert.strictEqual(r.records[0].cpu, 11);
  assert.strictEqual(r.records[0].ram, 1034);
});

// ── JSON-RPC：历史记录 ─────────────────────────────────────
test('RPC common:getRecords(type=load)：扁平数组字段集与 load_type 分组不变', async () => {
  const rows = await rpc('common:getRecords', { type: 'load', uuid: A, hours: 1 });
  assert.ok(Array.isArray(rows), 'load 记录必须是裸数组');
  assert.deepStrictEqual(keysOf(rows[0]), [
    'client', 'cpu', 'disk', 'disk_total', 'load', 'net_in', 'net_out', 'net_total_down',
    'net_total_up', 'process', 'ram', 'ram_total', 'swap', 'swap_total', 'temp', 'time', 'uptime'
  ]);
  const latest = rows[rows.length - 1];
  assert.strictEqual(latest.cpu, 11);
  assert.strictEqual(latest.ram, 1034);
  assert.strictEqual(latest.uptime, 0, 'loadOne 不取 uptime 列，保持 0 伪值（该契约刻意保留）');

  const cpu = await rpc('common:getRecords', { type: 'load', uuid: A, hours: 1, load_type: 'cpu' });
  assert.deepStrictEqual(keysOf(cpu[0]), ['client', 'cpu', 'time']);

  const network = await rpc('common:getRecords', { type: 'load', uuid: A, hours: 1, load_type: 'network' });
  assert.deepStrictEqual(keysOf(network[0]), [
    'client', 'net_in', 'net_out', 'net_total_down', 'net_total_up', 'time'
  ]);

  // gpu 不采集：分组为空 → 仅剩 client/time
  const gpu = await rpc('common:getRecords', { type: 'load', uuid: A, hours: 1, load_type: 'gpu' });
  assert.deepStrictEqual(keysOf(gpu[0]), ['client', 'time']);

  // connections 在 RPC 侧无对应列（LOAD_FIELD_MAP 不含该键）→ 同样只留 client/time
  const conn = await rpc('common:getRecords', { type: 'load', uuid: A, hours: 1, load_type: 'connections' });
  assert.deepStrictEqual(keysOf(conn[0]), ['client', 'time']);
});

test('RPC common:getRecords(metric_keys)：点分命名与 load.5/uptime 不变', async () => {
  const r = await rpc('common:getRecords', {
    uuid: A, hours: 1,
    metric_keys: ['cpu.usage', 'memory.used', 'swap.used', 'temperature', 'uptime', 'load.5']
  });
  const rec = r.records[r.records.length - 1];
  assert.deepStrictEqual(keysOf(rec), [
    'cpu.usage', 'load.5', 'memory.used', 'swap.used', 'temperature', 'time', 'uptime'
  ]);
  assert.strictEqual(rec['cpu.usage'], 11);
  assert.strictEqual(rec['memory.used'], 1034);
  assert.strictEqual(rec['swap.used'], 128);
  assert.strictEqual(rec['load.5'], 0.4);
  assert.strictEqual(rec.temperature, 45);
});

// ── JSON-RPC：延迟与 metrics ───────────────────────────────
test('RPC public:getPingRecords / getPingMetricStats：字段与失败样本口径不变', async () => {
  const pr = await rpc('public:getPingRecords', { uuid: A, hours: 1 });
  assert.deepStrictEqual(keysOf(pr.records[0]), ['client', 'task_id', 'time', 'value']);

  const st = await rpc('public:getPingMetricStats', { entity_id: A, hours: 1 });
  assert.deepStrictEqual(keysOf(st.stats[0]), [
    'avg', 'client', 'entity_id', 'interval', 'interval_seconds', 'latest', 'loss',
    'loss_approximate', 'max', 'min', 'name', 'p50', 'p99', 'p99_p50_ratio', 'stddev',
    'task_id', 'total', 'type', 'valid'
  ]);
  const dead = st.stats.find((s) => s.name === '全丢');
  assert.ok(dead, '全丢包任务也要出 stats');
  assert.strictEqual(dead.total, 5);
  assert.strictEqual(dead.valid, 0);
  assert.strictEqual(dead.loss, 100);
  assert.strictEqual(typeof dead.task_id, 'string');
});

test('RPC public:queryMetrics：series 信封与指标取值不变', async () => {
  const r = await rpc('public:queryMetrics', {
    entity_id: A, hours: 1,
    metric_keys: ['cpu.usage', 'memory.used', 'swap.used', 'temperature', 'ping.latency_ms', 'ping.loss']
  });
  assert.ok(Array.isArray(r.series));
  assert.deepStrictEqual(keysOf(r.series[0]), [
    'count', 'downsampled', 'entity_id', 'metric_key', 'name', 'points',
    'retention_days', 'task_id', 'task_name', 'unit'
  ]);
  const swap = r.series.find((s) => s.metric_key === 'swap.used');
  assert.strictEqual(swap.points[swap.points.length - 1].value, 128);
  assert.notStrictEqual(swap.points[swap.points.length - 1].value, 1034, 'swap 不得再冒充内存');
  const cpu = r.series.find((s) => s.metric_key === 'cpu.usage');
  assert.strictEqual(cpu.points[cpu.points.length - 1].value, 11);
});

test('RPC public:getPublicPingTasks：官方 7 字段 + diting 超集不变', async () => {
  const tasks = await rpc('public:getPublicPingTasks', { entity_id: A });
  assert.deepStrictEqual(keysOf(tasks[0]), [
    'client', 'clients', 'default_on', 'entity_id', 'id', 'interval',
    'interval_seconds', 'name', 'task_id', 'task_name', 'type', 'weight'
  ]);
  assert.strictEqual(tasks.find((t) => t.name === '移动').interval, 60);
});
