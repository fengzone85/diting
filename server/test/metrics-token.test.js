'use strict';
// ============================================================
// /metrics 与管理接口使用同一 Token 口径（P0：数据库哈希唯一权威）。
//
// 旧行为：_metricsHandler 直接比对 process.env.ADMIN_TOKEN，而管理接口走
//         getAdminToken()（占位符 / <16 位视为不可用）→ 弱 Token 仍可拉指标。
// 新口径：库中无哈希 = 未初始化；有哈希则明文 → sha256 → 恒时比较。
//         env 只在启动期做一次性迁移，运行期改 env 不再有任何效果。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';   // 只测 Token 口径，不测 HTTPS 强制
process.env.DB_PATH = '/tmp/diting-metrics-token-test.db';
// 置空而非 delete：dotenv 只填充"未定义"的键，delete 会让 server/.env 里的真实
// ADMIN_TOKEN 被读进来并迁移入库，导致本文件首个用例（未初始化）失真。
process.env.ADMIN_TOKEN = '';          // 首次启动为未初始化，由用例写入哈希
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
const db = require('../src/db');
const { hashAdminToken } = require('../src/token-policy');

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

test('/metrics：库中无哈希 → 401 not configured', async () => {
  const res = await getMetrics(STRONG);
  assert.strictEqual(res.status, 401);
  assert.match(res.text, /not configured/i);
});

test('/metrics：写入哈希后，正确 Token 返回 200', async () => {
  db.setAdminTokenHash(hashAdminToken(STRONG));
  const res = await getMetrics(STRONG);
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /monitor_up/);
});

test('/metrics：错误 Token → 401', async () => {
  const res = await getMetrics('metrics-admin-token-wrong-000000000000');
  assert.strictEqual(res.status, 401);
});

test('/metrics：运行期改 env 不再生效（env 只在启动期做一次性迁移）', async () => {
  process.env.ADMIN_TOKEN = 'short';          // 旧实现下这是"弱 Token 绕过"的入口
  try {
    const res = await getMetrics('short');
    assert.strictEqual(res.status, 401);
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
});

test('/metrics：缺少 Authorization 头 → 401', async () => {
  const res = await request(app).get('/metrics');
  assert.strictEqual(res.status, 401);
});
