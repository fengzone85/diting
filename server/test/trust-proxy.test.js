'use strict';
// ============================================================
// H-02 回归护栏：反向代理信任边界
//
// 背景：此前 server.js 为 `app.set('trust proxy', true)`（信任任意来源的
// X-Forwarded-*）。一旦 :8081 被直连，攻击者可自造
//   X-Forwarded-For: <白名单内 IP>   → 绕过 admin_allow_ips / 按 IP 限流
//   X-Forwarded-Proto: https         → 让 requireProto 放行明文管理请求
// 现默认只信任 loopback，其余拓扑用 TRUST_PROXY 显式声明。
//
// 本文件用「非回环地址」直连服务（而非 supertest 的 127.0.0.1），
// 以此模拟"8081 被直接暴露"的场景，断言伪造头不被采信。
// ============================================================

process.env.PORT = '0';                       // 随机端口，取 server.address().port
process.env.ADMIN_ALLOW_HTTP = '1';           // 只测 IP 判定，不测 HTTPS 强制
process.env.ADMIN_TOKEN = 'tproxy-admin-token-0123456789abcdef';
process.env.READONLY_TOKEN = 'tproxy-readonly-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-trust-proxy-test.db';
delete process.env.TRUST_PROXY;               // 确保走默认（loopback）

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const ai = require('../src/ai');

// 取一个非回环 IPv4（模拟外部客户端直连 :8081）；CI 上通常有 eth0
function externalIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

function get(ip, port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: ip, port, path: '/api/agents', method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

after(async () => {
  alerts.stop();
  ai.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

test('默认 trust proxy = loopback（不再信任任意来源）', () => {
  assert.strictEqual(app.get('trust proxy'), 'loopback');
});

test('非回环来源伪造 X-Forwarded-For 不能绕过 admin_allow_ips', async (t) => {
  const ip = externalIp();
  if (!ip) return t.skip('当前环境无可用非回环 IPv4，跳过');

  const port = server.address().port;
  const ui = db.getUiSettings();
  db.setUiSettings(Object.assign({}, ui, { admin_allow_ips: '203.0.113.9' }));
  try {
    // 伪造白名单内 IP：源地址非回环且在信任名单外 → XFF 不应被采信 → 403
    const forged = await get(ip, port, { 'X-Forwarded-For': '203.0.113.9' });
    assert.strictEqual(forged, 403, 'trust proxy 收紧后伪造 XFF 必须被拒绝');

    // 不伪造：真实源 IP 不在白名单 → 同样 403（确认上面不是因为其他原因被拒）
    const plain = await get(ip, port, {});
    assert.strictEqual(plain, 403);
  } finally {
    db.setUiSettings(ui);
  }
});
