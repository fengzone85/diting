'use strict';
// ============================================================
// 外部审查复核 Batch D：D5 compat/v1 限流统一走 rateLimitTouch 的接线验收。
//   C 容量满不误伤活跃 IP（C3）；A/B 配额与 429 信封；D 窗口边界不截断成 2 倍速率（C-3）。
// 负向对照：git show HEAD:server/src/{compat,v1}.js 旧版跑本文件 C/D 应失败。
// 注意：compat/v1 挂在 api router 之后，全局 60/10s 也计数 ⇒ 各用例独立 IP、总量 ≤60。
// C 必须首个运行：容量路径对「表内已有条目数」敏感，前置用例会污染计数。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'audit-d-admin-token-0123456789abcdef';
process.env.READONLY_TOKEN = 'audit-d-readonly-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-audit-d-ratelimit.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const { server } = require('../server');
const alerts = require('../src/alerts');
const ai = require('../src/ai');
const rollup = require('../src/rollup');
const T_BOOT = Date.now(); // require 期间注册旧版 setInterval；以其后时刻为基准留足裕量

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
function req(pathname, ip) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path: pathname, agent,
      headers: { 'X-Forwarded-For': ip },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let body = null;
        try { body = buf ? JSON.parse(buf) : null; } catch { /* 404/SPA 回退为 HTML */ }
        resolve({ status: res.statusCode, body });
      });
    });
    r.on('error', reject);
    r.end();
  });
}
const burst = (pathname, ip, n) => Promise.all(Array.from({ length: n }, () => req(pathname, ip)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  alerts.stop();
  ai.stop();
  rollup.stop();
  agent.destroy();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

test('D5-C 容量满：淘汰最旧而非清表，活跃 IP 配额不被重置（C3）', async () => {
  const active = '10.9.0.3';
  // 先填 9999 个新 IP，再让 active 发满配额（active 的 reset 最新，不会成为淘汰对象）
  // 填充走 404 路径：限流在路由匹配前计数，且无 DB 读，保证填充远快于 10s 窗口
  for (let base = 0; base < 9999; base += 100) {
    const batch = [];
    for (let i = base; i < Math.min(base + 100, 9999); i++) {
      batch.push(req('/api/v1/fill-404', `10.10.${(i >> 8) & 255}.${i & 255}`));
    }
    await Promise.all(batch);
  }
  const ok = await burst('/api/v1/sites', active, 30);
  assert.ok(ok.every((r) => r.status === 200));
  // 第 10001 个 IP 触发容量路径：旧版整表清（active 计数被清零），新版只淘汰最旧
  await req('/api/v1/sites', '10.10.255.255');
  const over = await req('/api/v1/sites', active);
  assert.strictEqual(over.status, 429, '容量满后活跃 IP 的第 31 次仍应被拒（旧版清表会放行）');
  assert.strictEqual(over.body.code, 1);
});

test('D5-A v1：30 次放行，第 31 次 429 且信封 {code:1}', async () => {
  const ip = '10.9.0.1';
  const ok = await burst('/api/v1/sites', ip, 30);
  assert.ok(ok.every((r) => r.status === 200), '配额内应全部 200');
  const over = await req('/api/v1/sites', ip);
  assert.strictEqual(over.status, 429);
  assert.strictEqual(over.body.code, 1);
  assert.strictEqual(over.body.message, 'too many requests');
});

test('D5-B compat：30 次放行，第 31 次 429 且信封 {status:error}', async () => {
  const ip = '10.9.0.2';
  const ok = await burst('/api/nodes', ip, 30);
  assert.ok(ok.every((r) => r.status === 200), '配额内应全部 200');
  const over = await req('/api/nodes', ip);
  assert.strictEqual(over.status, 429);
  assert.strictEqual(over.body.status, 'error');
  assert.strictEqual(over.body.message, 'too many requests');
});

test('D5-D 窗口边界：边界前发满配额，边界后不立即重置（C-3）', async () => {
  const ip = '10.9.0.4';
  // 旧版整表清发生在 require+10s；首批在 +8.5s（清表前），次批在 +10.6s（清表后）
  await sleep(Math.max(0, T_BOOT + 8500 - Date.now()));
  const first = await burst('/api/v1/sites', ip, 30);
  assert.ok(first.every((r) => r.status === 200), '首批配额内应 200');
  await sleep(Math.max(0, T_BOOT + 10600 - Date.now()));
  const second = await burst('/api/v1/sites', ip, 30);
  assert.ok(second.every((r) => r.status === 429), '同一窗口内第二批应全 429（旧版整表清会放行=2 倍速率）');
  assert.ok(second.every((r) => r.body.code === 1));
});