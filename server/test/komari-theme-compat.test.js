'use strict';
// ============================================================
// 真实 Komari 社区主题联调回归（2026-10-29）
//
// 用 komari-theme-Glassmorphism v3.4.4 的真实产物实测发现三处阻塞，此处逐条锁死：
//   1. Komari 格式主题包（komari-theme.json）不写 diting.* 字段，但普遍含内联脚本与
//      外部图标/汇率请求 → 必须默认放宽该主题页的 CSP，否则内联脚本被拦、图标/图表异常；
//   2. 主题根链接常带尾斜杠（/themes/<short>/），此前被 /themes/<id>/(.*) 路由吃掉后
//      越界检查误判 → 404；
//   3. Komari 的 public:queryMetrics 返回 []publicMetricSeries（裸数组），diting 曾返回
//      { start, end, series } 信封 → 主题按数组解析，图表恒「暂无数据」。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'km-compat-admin-token-0123456789ab';
process.env.DB_PATH = '/tmp/diting-komari-compat.db';
process.env.THEMES_DIR = '/tmp/diting-komari-compat/themes';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const ROOT = '/tmp/diting-komari-compat';
const DB = process.env.DB_PATH;
for (const sfx of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(DB + sfx); } catch { /* 不存在则忽略 */ }
}
fs.rmSync(ROOT, { recursive: true, force: true });

// 造一个「Komari 格式」主题包（真实社区主题的最小等价物）
const SHORT = 'KmProbe';
const DIR = path.join(process.env.THEMES_DIR, SHORT);
fs.mkdirSync(path.join(DIR, 'assets'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'komari-theme.json'), JSON.stringify({
  name: 'Komari Probe Theme',
  short: SHORT,
  version: '1.0.0',
  configuration: { type: 'managed', name: '主题设置', data: [] }
}));
fs.writeFileSync(path.join(DIR, 'index.html'),
  '<!doctype html><html><head><script>window.__km=1</script></head><body>km-theme</body></html>');
fs.writeFileSync(path.join(DIR, 'assets', 'app.js'), 'console.log("km")');

// 必须在主题目录就绪后再 require('../server')：nonce 集合在模块加载时按 manifest 重建
const { app, server } = require('../server');
const db = require('../src/db');

// 启用该主题（公共页投放）
const ui = db.getUiSettings();
db.setUiSettings({ ...ui, public_enabled: true, public_theme: SHORT });

after(() => {
  try { server.close(); } catch { /* 已关闭 */ }
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const sfx of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + sfx); } catch { /* 忽略 */ }
  }
});

test('komari 格式主题默认放宽 CSP：注入 nonce 且 connect-src 含图标/汇率源', async () => {
  const res = await request(app).get(`/themes/${SHORT}`).expect(200);
  const csp = res.headers['content-security-policy'] || '';
  assert.match(csp, /script-src 'self' 'nonce-/, '应存在一次性 nonce');
  assert.ok(csp.includes('https://open.er-api.com'), 'connect-src 应允许汇率 API（Glassmorphism 依赖）');
  assert.ok(csp.includes('https://api.iconify.design'), 'connect-src 应允许 Iconify');
  assert.match(res.text, /<script nonce="/, '内联脚本应被注入 nonce');
});

test('主题根带尾斜杠不再 404（回归）', async () => {
  await request(app).get(`/themes/${SHORT}/`).expect(200);
});

test('主题资源仍可访问', async () => {
  await request(app).get(`/themes/${SHORT}/assets/app.js`).expect(200);
});

test('RPC public:queryMetrics 返回裸数组（Komari 契约，信封会导致图表恒空）', async () => {
  const { id } = db.createAgent({ name: 'km-node' });
  db.insertMetric(id, { ts: Date.now(), cpu: 12.5, mem_total: 8192, mem_used: 1024 });

  const res = await request(app)
    .post('/api/rpc2')
    .send({ jsonrpc: '2.0', id: 1, method: 'public:queryMetrics', params: { metric_keys: ['cpu.usage'], entity_id: id, hours: 1 } })
    .expect(200);

  assert.ok(Array.isArray(res.body.result), 'result 必须是数组（不是 { start, end, series } 信封）');
  assert.ok(res.body.result.length >= 1, '应至少返回一条 series');
  assert.strictEqual(res.body.result[0].metric_key, 'cpu.usage');
  assert.ok(Array.isArray(res.body.result[0].points), 'series 应含 points 数组');
});

test('RPC metrics:query（位置参数形态）与 public:queryMetrics 同构', async () => {
  const agents = db.getMonitoredAgents();
  const id = agents[0].id;
  const res = await request(app)
    .post('/api/rpc2')
    .send({
      jsonrpc: '2.0', id: 2, method: 'metrics:query',
      params: [['cpu.usage'], id, null, 1, null, null, 500, 'avg', true]
    })
    .expect(200);
  assert.ok(Array.isArray(res.body.result), 'metrics:query 也必须返回数组');
});

test('RPC common:getRecords(type=load) 返回扁平数组（LoadChart 契约）', async () => {
  const id = db.getMonitoredAgents()[0].id;
  const res = await request(app)
    .post('/api/rpc2')
    .send({ jsonrpc: '2.0', id: 3, method: 'common:getRecords', params: { type: 'load', uuid: id, hours: 1, max_count: 6000 } })
    .expect(200);

  assert.ok(Array.isArray(res.body.result), 'load 记录必须是数组（不是 { count, records } 信封）');
  assert.ok(res.body.result.length >= 1, '应有至少一条记录');
  const first = res.body.result[0];
  assert.strictEqual(first.client, id);
  assert.strictEqual(typeof first.time, 'string');
  assert.ok(Number.isFinite(first.cpu), '扁平字段 cpu 应有数值');
  assert.ok(Number.isFinite(first.ram), '扁平字段 ram 应有数值');
  assert.ok(!('gpu' in first), 'gpu 不采集，不应出现该字段');
});

test('RPC common:getRecords 的 load_type 过滤生效', async () => {
  const id = db.getMonitoredAgents()[0].id;
  const res = await request(app)
    .post('/api/rpc2')
    .send({ jsonrpc: '2.0', id: 4, method: 'common:getRecords', params: { type: 'load', uuid: id, hours: 1, load_type: 'cpu' } })
    .expect(200);
  const first = res.body.result[0];
  assert.ok('cpu' in first, 'load_type=cpu 时应含 cpu');
  assert.ok(!('ram' in first), 'load_type=cpu 时不应含 ram');
});
