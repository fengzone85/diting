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
