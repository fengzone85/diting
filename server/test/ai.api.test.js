'use strict';
// ============================================================
// /api/ai/run 接口回归：异步触发语义（202/400/409/429）与运行状态字段
//
// 【不联网】把 base_url 指向 http://127.0.0.1:9/v1（discard 端口，连接必然被拒）：
// provider 立刻抛可重试错误 → generateAndSend 走「降级为纯统计版」路径，
// 既覆盖了完整异步链路，又不会真的调用模型、不会等 180s 协议超时。
//
// 运行前提（必须在 require('../server') 之前设置）：
//   1. PORT=0            —— 随机端口，避免与 systemd 服务(8081)冲突
//   2. ADMIN_ALLOW_HTTP=1 —— 绕过 requireProto 的 HTTPS 强制（仅测试环境）
//   3. ADMIN_TOKEN        —— 测试专用凭证
//   4. DB_PATH 指向 /tmp 临时库 —— 绝不触碰生产 monitor.db
// ============================================================

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'itest-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-ai-api-test.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

// 必须在 require('../server') 之前清理残留库文件（db.js 在 require 链中就会打开 DB）
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const ai = require('../src/ai');

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };

after(async () => {
  ai.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// 轮询等待后台任务结束（异步触发的核心语义：接口立即返回，任务在后台跑）
async function waitIdle(timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    const res = await request(app).get('/api/ai/status').set(ADMIN);
    if (res.status === 200 && res.body.running === false) return res.body;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待 AI 任务结束超时');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('AI 未启用时 POST /api/ai/run → 400，且不写 ai_state（不占冷却）', async () => {
  const res = await request(app).post('/api/ai/run').set(ADMIN);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.status, 'disabled');

  const st = await request(app).get('/api/ai/status').set(ADMIN);
  assert.strictEqual(st.body.last_run_ts, 0, '未启用不应推进 last_run_ts');
});

test('AI 未启用时 POST /api/ai/analyze-node/:id → 400', async () => {
  const res = await request(app).post('/api/ai/analyze-node/agt_whatever').set(ADMIN);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.status, 'disabled');
});

test('启用后触发 → 202 立即返回；后台跑完写入 degraded 状态与耗时', async () => {
  const cfg = await request(app).put('/api/ai/config').set(ADMIN).send({
    config: {
      enabled: true,
      model: 'test-model',
      api_key: 'sk-test-not-used',
      base_url: 'http://127.0.0.1:9/v1'
    }
  });
  assert.strictEqual(cfg.status, 200);

  const res = await request(app).post('/api/ai/run').set(ADMIN);
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.body.status, 'accepted');

  const st = await waitIdle();
  assert.strictEqual(st.running, false);
  assert.strictEqual(st.last_status, 'degraded', '模型不可达时应降级而非失败');
  assert.ok(st.last_duration_ms > 0, '应记录本次耗时');
});

test('降级后 60s 内再次触发 → 429 + Retry-After（最需要重试的场景只挡 60s）', async () => {
  const res = await request(app).post('/api/ai/run').set(ADMIN);
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.status, 'cooldown');
  assert.ok(res.body.retry_after_s > 0 && res.body.retry_after_s <= 60, 'degraded 冷却应为 60s 档');
  assert.ok(res.headers['retry-after'], '应带 Retry-After 头');
});

test('?force=1 绕过冷却 → 202', async () => {
  const res = await request(app).post('/api/ai/run?force=1').set(ADMIN);
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.body.status, 'accepted');
  await waitIdle();
});

test('节点不存在时 POST /api/ai/analyze-node/:id → 404（AI 已启用）', async () => {
  const res = await request(app).post('/api/ai/analyze-node/agt_does_not_exist').set(ADMIN);
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.status, 'not_found');
});

test('GET /api/ai/usage 返回按日聚合与合计（降级报告的 token 记为 0）', async () => {
  const res = await request(app).get('/api/ai/usage?days=7').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.days, 7);
  assert.ok(Array.isArray(res.body.list));
  assert.ok(typeof res.body.total_tokens === 'number' && res.body.total_tokens >= 0);
  for (const row of res.body.list) {
    assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row.reports >= 1);
  }
});

test('状态接口暴露 running / last_duration_ms / started_at 字段', async () => {
  const st = await waitIdle();
  assert.ok(Object.prototype.hasOwnProperty.call(st, 'running'), '缺 running');
  assert.ok(Object.prototype.hasOwnProperty.call(st, 'last_duration_ms'), '缺 last_duration_ms');
  assert.ok(Object.prototype.hasOwnProperty.call(st, 'started_at'), '缺 started_at');
});

// ---- §9 T19：周期对比端到端（走降级路径落库，不调模型）----
// 降级报告的 report_json.summary.agents[] 就是喂给模型的原始摘要，因此可直接断言 compare 字段：
//   ① 两个窗口都有数据 → compare 存在且差值符号为「当期 − 前一期」；
//   ② 只有当期窗口有数据 → compare=null 且 compare_insufficient=true（prompt 据此禁止推断趋势）。
const db = require('../src/db');

function mkMetric(agentId, ts, over) {
  return Object.assign({
    agent_id: agentId, ts, cpu: 10, mem_used: 1, mem_total: 2, mem_pct: 50,
    disk_used: 50, disk_total: 100, disk_pct: 50, load1: 1, load5: 1, load15: 1,
    net_rx_rate: 1000, net_tx_rate: 1000, net_rx_month: 1, net_tx_month: 1, uptime: 1,
    temp: 40, swap_used: 0, swap_total: 0, swap_pct: 0, disk_r_rate: 0, disk_w_rate: 0,
    probes: null, disks: null
  }, over || {});
}

test('日报摘要带周期对比：有前窗时给差值，缺前窗时标记 insufficient', async () => {
  const now = Date.now();
  const HOUR = 3600000;
  const a = db.createAgent({ name: 'cmp-both' }).id;       // 两个窗口都有数据
  const b = db.createAgent({ name: 'cmp-cur-only' }).id;   // 只有当期

  for (let i = 0; i < 48; i++) {
    const ts = now - i * HOUR;
    // 当期（近 24h）cpu=20；前窗（24–48h）cpu=10 → cpu_avg_delta 应为 +10
    db.insertMetric(a, mkMetric(a, ts, { cpu: i < 24 ? 20 : 10, mem_pct: i < 24 ? 60 : 50 }));
    if (i < 24) db.insertMetric(b, mkMetric(b, ts, { cpu: 30 }));
  }

  const res = await request(app).post('/api/ai/run?force=1').set(ADMIN);
  assert.strictEqual(res.status, 202);
  await waitIdle();

  const row = db.db.prepare('SELECT report_json FROM ai_reports ORDER BY id DESC LIMIT 1').get();
  const summary = JSON.parse(row.report_json).summary;
  const sa = summary.agents.find(x => x.name === 'cmp-both');
  const sb = summary.agents.find(x => x.name === 'cmp-cur-only');

  assert.ok(sa && sa.compare, '两窗口都有数据时应给出 compare');
  assert.strictEqual(sa.compare_insufficient, false);
  assert.strictEqual(sa.compare.window, '24h');
  assert.strictEqual(sa.compare.cpu_avg_delta, 10, '当期 20 − 前窗 10');
  assert.strictEqual(sa.compare.mem_avg_delta, 10, '当期 60 − 前窗 50');

  assert.ok(sb, '应存在只当期有数据的节点');
  assert.strictEqual(sb.compare, null, '前窗无数据时 compare 必须为 null');
  assert.strictEqual(sb.compare_insufficient, true, '必须显式标记，供 prompt 禁止推断趋势');
});

// ---- §9 T18：核数链路（上报 → 落库 → 摘要负载归一化）----
const sum = require('../src/ai/summarizer');

test('核数链路：/api/report 带 cores → 落库 → 摘要给出每核负载；缺失/越界不清零', async () => {
  const a = db.createAgent({ name: 'cores-agent' });
  const auth = { 'X-Agent-ID': a.id, Authorization: `Bearer ${a.token}` };
  const base = {
    cpu: 10, mem_used: 100, mem_total: 1000, mem_pct: 10,
    disk_used: 1, disk_total: 2, disk_pct: 50,
    load1: 2, load5: 2, load15: 2,
    net_rx_rate: 1, net_tx_rate: 2, net_rx_month: 3, net_tx_month: 4,
    uptime: 100, temp: null, swap_used: 0, swap_total: 0, swap_pct: 0,
    disk_r_rate: 0, disk_w_rate: 0, cores: 4
  };

  const res = await request(app).post('/api/report').set(auth).send(base);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(db.getAgent(a.id).cores, 4, '核数应落到 agents.cores');

  const summary = sum.summarizeOne(db.getAgent(a.id), { periodHours: 24 });
  assert.strictEqual(summary.cpu.cores, 4);
  assert.strictEqual(summary.load.avg1, 2);
  assert.strictEqual(summary.load.avg1_per_core, 0.5, '2 / 4 核');

  // 老 agent（不带 cores）继续上报：不得把已记录的核数清成 0
  const legacy = Object.assign({}, base);
  delete legacy.cores;
  assert.strictEqual((await request(app).post('/api/report').set(auth).send(legacy)).status, 200);
  assert.strictEqual(db.getAgent(a.id).cores, 4, '缺失 cores 不得覆盖已有值');

  // 越界/非法核数应被校验拒收（保持原值）
  await request(app).post('/api/report').set(auth).send(Object.assign({}, base, { cores: 99999 }));
  await request(app).post('/api/report').set(auth).send(Object.assign({}, base, { cores: 'many' }));
  assert.strictEqual(db.getAgent(a.id).cores, 4, '非法核数不得写入');

  // 未上报核数的节点：摘要必须缺席分母并显式标记 cores_unknown
  const b = db.createAgent({ name: 'no-cores-agent' });
  const authB = { 'X-Agent-ID': b.id, Authorization: `Bearer ${b.token}` };
  const nb = Object.assign({}, base);
  delete nb.cores;
  await request(app).post('/api/report').set(authB).send(nb);
  const sb = sum.summarizeOne(db.getAgent(b.id), { periodHours: 24 });
  assert.strictEqual(sb.cpu.cores, null);
  assert.strictEqual(sb.load.cores_unknown, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(sb.load, 'avg1_per_core'), '不得用 0/1 冒充分母');
});
