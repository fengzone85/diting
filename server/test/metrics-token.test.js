'use strict';
// ============================================================
// /metrics 与后台管理接口使用同一 Token 强度口径。
//
// 背景：此前 _metricsHandler 直接比对 process.env.ADMIN_TOKEN，而管理接口走
// getAdminToken()（占位符 / <16 位视为不可用）。结果是弱 Token 虽进不了后台，
// 却仍能凭 Bearer 拉取全部指标。现两处统一走 src/token-policy。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';   // 只测 Token 口径，不测 HTTPS 强制
process.env.ADMIN_TOKEN = 'metrics-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-metrics-token-test.db';
// 禁服真实通知（与 security-fixes-p2.test.js 同因）：避免 dotenv 注入的 SMTP 占位符联网。
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const alerts = require('../src/alerts');

const STRONG = 'metrics-admin-token-0123456789abcdef';

after(async () => {
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

function getMetrics(bearer) {
  return request(app).get('/metrics').set('Authorization', `Bearer ${bearer}`);
}

test('/metrics：强 Token 正常返回', async () => {
  process.env.ADMIN_TOKEN = STRONG;
  const res = await getMetrics(STRONG);
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /monitor_up/);
});

test('/metrics：短 Token 被拒绝（401），不再绕过强度判定', async () => {
  process.env.ADMIN_TOKEN = 'short';
  const res = await getMetrics('short');
  assert.strictEqual(res.status, 401);
});

test('/metrics：示例占位符被拒绝（401）', async () => {
  process.env.ADMIN_TOKEN = 'change-me-admin-token';
  const res = await getMetrics('change-me-admin-token');
  assert.strictEqual(res.status, 401);
});

test('/metrics：未配置 ADMIN_TOKEN 时同样 401', async () => {
  delete process.env.ADMIN_TOKEN;
  const res = await getMetrics('anything');
  assert.strictEqual(res.status, 401);
  process.env.ADMIN_TOKEN = STRONG; // 还原，避免影响后续断言
});
