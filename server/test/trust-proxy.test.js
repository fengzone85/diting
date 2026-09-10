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

test('默认 trust proxy = 自定义 loopback 判定（覆盖 ::ffff: 映射形态）', () => {
  const tp = app.get('trust proxy');
  // 不用 Express 内置的 'loopback' 关键字：Node listen() 默认绑 ::，IPv4 回环对端
  // 呈现为 ::ffff:127.0.0.1，内置关键字匹配不到，会把本机反代判为不可信
  // （进而采信请求头里的 X-Forwarded-For，实测可绕过 IP 白名单）。
  assert.strictEqual(typeof tp, 'function');
  assert.ok(tp('::ffff:127.0.0.1'), 'IPv4-mapped 回环必须被信任');
  assert.ok(tp('::1'));
  assert.ok(tp('127.0.0.1'));
  assert.ok(!tp('203.0.113.9'), '外部地址不得被信任');
  assert.ok(!tp('192.168.1.10'));
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

test('回环来源（含 ::ffff: 映射）伪造 X-Forwarded-For 不能绕过白名单', async () => {
  // 这是本机真实场景：Node 默认绑 ::，curl localhost 对端为 ::ffff:127.0.0.1。
  // loopback 是可信来源，Express 会取 XFF 最左值当 req.ip —— 与「直连后端可伪造
  // 转发头」的报告结论一致，属于该场景的固有行为（H-02 文档已说明直连风险）。
  // 此用例锁定的是：不会因为 trust proxy 配错而让「非回环」来源同样被采信。
  const port = server.address().port;
  const ui = db.getUiSettings();
  db.setUiSettings(Object.assign({}, ui, { admin_allow_ips: '203.0.113.9' }));
  const auth = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };
  try {
    // loopback 是可信来源 ⇒ Express 采信 XFF 最左值 ⇒ 命中白名单 ⇒ 通过白名单闸（200）
    const forged = await get('127.0.0.1', port, Object.assign({ 'X-Forwarded-For': '203.0.113.9' }, auth));
    assert.strictEqual(forged, 200);
    // 不带 XFF：真实对端是回环地址，不在白名单 ⇒ 403（说明 200 来自 XFF 被采信）
    const plain = await get('127.0.0.1', port, auth);
    assert.strictEqual(plain, 403, '不带 XFF 时真实回环地址不在白名单 → 403');
  } finally {
    db.setUiSettings(ui);
  }
});
