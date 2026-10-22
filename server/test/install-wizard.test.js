'use strict';
// 安装向导（复刻 komari install wizard）行为测试：
//   未安装拦截（页面 307 → /install、管理面 404、agent/SETUP_TOKEN 面放行）、
//   complete 校验（sitename/description/站点与上报地址/自定义 Token 强度）、
//   requireProto 的 SSH 隧道例外（回环 + 零代理头）、
//   原子抢写哈希入库、站点信息持久化、「安装后锁定」、以及"不写 .env"。
//
// 运行前提（必须在 require('../server') 之前设置，与其它集成测试一致）：
//   PORT=0 / ADMIN_ALLOW_HTTP=1 / DB_PATH 指向 /tmp 临时库；
//   故意不设 ADMIN_TOKEN（未安装正是被测主体）；DITING_ENV_PATH 指向 /tmp 的哨兵路径，
//   用于断言"向导不再写 .env"。

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.DB_PATH = '/tmp/diting-install-wizard-test.db';
// 显式置空而不是 delete：server.js 第一行 `require('dotenv').config()` 会读工作目录下的
// 真实 .env（在部署机/生产树里跑测试时它确实存在），delete 之后会被 dotenv 重新填回，
// 导致启动时把 ADMIN_TOKEN 迁进临时库、实例变成"已安装"，本文件所有"未安装"前提全废。
// dotenv 不覆盖已存在的键，故留一个空串即可保持"未设置"语义（tokenIssue('') = missing）。
process.env.ADMIN_TOKEN = '';
process.env.DITING_ENV_PATH = '/tmp/diting-install-wizard-test.env';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 必须在 require('../server') 之前清理残留：db.js 在 require 链中就会打开 DB
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}
try { fs.unlinkSync(process.env.DITING_ENV_PATH); } catch { /* 不存在则忽略 */ }

// SPA 入口产物（public/index.html）是构建产物不入库。本测试需要真实存在的入口文件
// 来锚定「/install 返回 SPA」与「安装完成后 / 恢复 200」；全新 checkout 未构建时写
// 最小占位 HTML，after 中清理（已存在则不碰）。
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');
const createdIndex = !fs.existsSync(INDEX_HTML);
if (createdIndex) {
  fs.writeFileSync(INDEX_HTML, '<!doctype html><html><body><div id="app"></div></body></html>');
}

const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, server } = require('../server');
const db = require('../src/db');
const install = require('../src/install');

const PROTO = { 'X-Forwarded-Proto': 'https' };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// complete 端点有 60s/5 次的 IP 限流；测试进程同源同 IP，逐用例轮换 X-Forwarded-For
// （TRUST_PROXY 默认采信 loopback 代理的 XFF）避免配额串扰。
// 注意：带 XFF 即"经反代的远程来源"，按 §6.7 抢占防护必须附带 install_token。
let xffSeq = 100;
const XFF = () => ({ ...PROTO, 'X-Forwarded-For': `203.0.113.${xffSeq++}` });
const INSTALL_TOKEN = 'install-token-7Kq2Xz9Rp4Wm';
process.env.SETUP_TOKEN = INSTALL_TOKEN;
// 远程来源的 complete 助手：带 XFF（= 不可信来源）+ 正确 install_token
const remoteComplete = (body) =>
  request(app).post('/api/install/complete').set(XFF()).send({ install_token: INSTALL_TOKEN, ...body });

after(async () => {
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  // 必须真正关掉 listener，否则 server.js 里的告警/保留期定时器会让事件循环不退出，
  // 测试跑完但进程挂住（其它 *.test.js 同样如此收尾）。
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  // 清理本测试留下的凭据与临时文件，避免泄漏进同进程后续测试或污染工作区
  process.env.ADMIN_TOKEN = '';
  if (createdIndex) { try { fs.unlinkSync(INDEX_HTML); } catch { /* ignore */ } }
  for (const f of [process.env.DITING_ENV_PATH, '/tmp/diting-install-e2e-custom.db']) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

// ---- 未安装状态：探测端点与拦截 ----

test('GET /api/install/status：未安装 → required=true、state=ready、带只读 port', async () => {
  const res = await request(app).get('/api/install/status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.required, true);
  assert.strictEqual(res.body.state, 'ready');
  assert.strictEqual(typeof res.body.port, 'number');
  assert.ok(res.body.port > 0 && res.body.port <= 65535);
});

test('未安装时页面 GET 一律 307 → /install（复刻 komari guideNoRoute）', async () => {
  for (const p of ['/', '/login', '/node/x', '/whatever']) {
    const res = await request(app).get(p);
    assert.strictEqual(res.status, 307, `GET ${p} 应 307 进安装向导`);
    assert.strictEqual(res.headers.location, '/install');
  }
  // 显式 /admin 路由（正则，先于 SPA fallback）同样 307
  const admin = await request(app).get('/admin');
  assert.strictEqual(admin.status, 307);
  assert.strictEqual(admin.headers.location, '/install');
});

test('未安装时 /install 本身可达（SPA 入口 200）', async () => {
  const res = await request(app).get('/install');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /<div id="app">/);
});

test('未安装时管理面 API → 404 not_found（对齐 komari Not found in install mode）', async () => {
  const agents = await request(app).get('/api/admin/agents');
  assert.strictEqual(agents.status, 404);
  assert.strictEqual(agents.body.error, 'not_found');
  const login = await request(app).post('/api/login').send({ token: 'x' });
  assert.strictEqual(login.status, 404);
  assert.strictEqual(login.body.error, 'not_found');
});

test('未安装时 agent 面 / SETUP_TOKEN 注册 / 旧 setup 端点不受拦截', async () => {
  // 公开 v1 面正常响应（非 404 not_found 即放行）
  const v1 = await request(app).get('/api/v1/nodes');
  assert.notStrictEqual(v1.body.error, 'not_found');
  // SETUP_TOKEN 未配置是业务层拒绝（而非 installGate 拦截），证明注册入口穿透了拦截
  const reg = await request(app).post('/api/setup/register').send({ setup_token: 'x' });
  assert.notStrictEqual(reg.body.error, 'not_found');
  // 旧 setup/status 兼容端点仍工作，且与向导同一判据（库中无哈希）
  const st = await request(app).get('/api/setup/status');
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.body.needs_setup, true);
});

// ---- complete 请求校验（对应 komari completeRequest 校验）----

test('complete：sitename 缺失/超长 → 400 invalid_sitename', async () => {
  const missing = await remoteComplete({ token_mode: 'generate', agent_server_url: 'https://pt.example.com' });
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(missing.body.error, 'invalid_sitename');
  const tooLong = await remoteComplete({ sitename: 'x'.repeat(101), token_mode: 'generate', agent_server_url: 'https://pt.example.com' });
  assert.strictEqual(tooLong.status, 400);
  assert.strictEqual(tooLong.body.error, 'invalid_sitename');
});

test('complete：description 超长 → 400 invalid_description', async () => {
  const res = await remoteComplete({ sitename: 'ok', description: 'x'.repeat(1001), token_mode: 'generate', agent_server_url: 'https://pt.example.com' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'invalid_description');
});

test('complete：上报地址必填且须为 http(s)（getPublicBaseUrl 的前置依赖）', async () => {
  const missing = await remoteComplete({ sitename: 'ok', token_mode: 'generate' });
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(missing.body.error, 'missing_agent_server_url');

  for (const bad of ['ftp://pt.example.com', 'pt.example.com', 'https://user:pass@pt.example.com', 'https://pt.example.com/' + 'x'.repeat(200)]) {
    const res = await remoteComplete({ sitename: 'ok', token_mode: 'generate', agent_server_url: bad });
    assert.strictEqual(res.status, 400, `agent_server_url=${JSON.stringify(bad).slice(0, 40)} 应被拒绝`);
    assert.strictEqual(res.body.error, 'invalid_agent_server_url');
  }
});

test('complete：站点网址可选，但非空时须合法', async () => {
  const bad = await remoteComplete({ sitename: 'ok', token_mode: 'generate', agent_server_url: 'https://pt.example.com', site_url: 'javascript:alert(1)' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error, 'invalid_site_url');
});

test('complete：自定义弱 Token 一律 400 weak_token', async () => {
  const cases = [
    '',                              // 空
    'change-me-admin-token',         // 示例占位符
    'short-token',                   // < 16 位
    '1234567890123456',              // 纯数字
    'aaaaaaaaaaaaaaaaaaaa',          // 字符种类过少
    'passwordpasswordabcd1234',      // 含连续序列
  ];
  for (const token of cases) {
    const res = await remoteComplete({ sitename: 'ok', token_mode: 'custom', token, agent_server_url: 'https://pt.example.com' });
    assert.strictEqual(res.status, 400, `token=${JSON.stringify(token)} 应被拒绝`);
    assert.strictEqual(res.body.error, 'weak_token');
  }
  // 校验失败不得消耗内存状态机，也不得写入哈希（哈希存在性就是初始化锁）
  const st = await request(app).get('/api/install/status');
  assert.strictEqual(st.body.state, 'ready');
  assert.strictEqual(db.getAdminTokenHash(), '');
});

// ---- requireProto 的 SSH 隧道例外 ----

test('requireProto：回环 + 带 X-Forwarded-Proto: http 仍 403（nginx 明文转发不得放行）', async () => {
  const prev = process.env.ADMIN_ALLOW_HTTP;
  delete process.env.ADMIN_ALLOW_HTTP; // 排除开发开关干扰，单独验证 loopback 判定
  try {
    const res = await request(app).post('/api/install/complete')
      .set({ 'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '203.0.113.200' })
      .send({ sitename: 'ok', token_mode: 'generate', agent_server_url: 'https://pt.example.com' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, 'https required');
  } finally {
    process.env.ADMIN_ALLOW_HTTP = prev;
  }
});

// ---- 抢占防护（§6.7 / G6）：远程来源必须带 install_token ----------------------

test('status：远程来源报 install_token_required=true，回环直连报 false', async () => {
  const remote = await request(app).get('/api/install/status').set(XFF());
  assert.strictEqual(remote.status, 200);
  assert.strictEqual(remote.body.install_token_required, true, '经反代的远程来源应要求口令');
  const local = await request(app).get('/api/install/status');
  assert.strictEqual(local.body.install_token_required, false, '回环直连（ssh -L）不应要求口令');
});

test('抢占防护：远程来源无口令 → 403 install_token_required', async () => {
  const bak = process.env.SETUP_TOKEN;
  delete process.env.SETUP_TOKEN;
  db.clearSetupToken(); db.markSetupTokenCleared();
  try {
    const res = await request(app).post('/api/install/complete').set(XFF())
      .send({ sitename: 'x', token_mode: 'generate', agent_server_url: 'https://pt.example.com' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, 'install_token_required');
  } finally {
    db.unmarkSetupTokenCleared();
    process.env.SETUP_TOKEN = bak;
  }
});

test('抢占防护：远程来源口令错误 → 403 invalid_install_token', async () => {
  const res = await request(app).post('/api/install/complete').set(XFF())
    .send({ sitename: 'x', token_mode: 'generate', agent_server_url: 'https://pt.example.com', install_token: 'wrong-token-0123456789' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'invalid_install_token');
});

test('抢占防护：远程来源口令正确 → 越过门槛进入业务校验（400 而非 403）', async () => {
  // 用非法 body：证明口令关卡已过、被后续 validateInstall 拦下，
  // 同时不会把这次安装真的消耗掉（后面还有成功安装用例）。
  const res = await remoteComplete({ sitename: 'x', token_mode: 'generate' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'missing_agent_server_url');
});

test('抢占防护：口令也可经 X-Install-Token 头传递', async () => {
  const res = await request(app).post('/api/install/complete').set(XFF())
    .set({ 'X-Install-Token': INSTALL_TOKEN })
    .send({ sitename: 'x', token_mode: 'generate' });
  assert.strictEqual(res.status, 400, '头形式的口令同样应被接受');
});

test('抢占防护：带代理头的回环请求（nginx 在本机转发）不算可信来源', async () => {
  const res = await request(app).post('/api/install/complete')
    .set({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.77' })
    .send({ sitename: 'x', token_mode: 'generate', agent_server_url: 'https://pt.example.com' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'invalid_install_token');
});

// ---- 成功安装（本用例同时验证：回环直连无需 https 头、Token 只存哈希、不写 .env）----

let issuedToken = '';

test('complete：回环直连完成安装 → 哈希入库、站点信息落库、不写 .env', async () => {
  const prev = process.env.ADMIN_ALLOW_HTTP;
  delete process.env.ADMIN_ALLOW_HTTP; // 不靠开发开关，靠 requireProto 的 loopback 例外
  try {
    // 不带任何代理头：supertest 从 127.0.0.1 直连，等价于 ssh -L 隧道访问
    const res = await request(app).post('/api/install/complete')
      .send({
        sitename: '探针面板',
        description: '安装向导回归',
        site_url: 'https://pt.example.com/',
        agent_server_url: 'https://pt.example.com:8443///',
        token_mode: 'generate',
      });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.status, 'success');
    assert.match(res.body.token, /^adm_[0-9a-f]{32}$/);
    issuedToken = res.body.token;
  } finally {
    process.env.ADMIN_ALLOW_HTTP = prev;
  }

  // 只存哈希：库中 64 位 hex 且等于 sha256(明文)
  assert.strictEqual(db.getAdminTokenHash(), sha256(issuedToken));
  assert.notStrictEqual(db.getAdminTokenHash(), issuedToken);

  // 站点信息四项入库，URL 已归一化（去尾斜杠/多余斜杠）
  const ui = db.getUiSettings();
  assert.strictEqual(ui.site_title, '探针面板');
  assert.strictEqual(ui.site_description, '安装向导回归');
  assert.strictEqual(ui.site_url, 'https://pt.example.com');
  assert.strictEqual(ui.agent_server_url, 'https://pt.example.com:8443');

  // 不再写 .env（容器内 /app/.env 不持久，写过一次就"重启即丢 Token"）
  assert.strictEqual(fs.existsSync(process.env.DITING_ENV_PATH), false, '向导不得再写 .env');
});

test('安装完成后：complete → 409（内存状态机）、status 翻转、旧锁键不被写入', async () => {
  const again = await remoteComplete({ sitename: '再装一次', token_mode: 'generate', agent_server_url: 'https://pt.example.com' });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.body.error, 'already_completed');

  const st = await request(app).get('/api/install/status');
  assert.strictEqual(st.body.required, false);
  assert.strictEqual(st.body.state, 'completed');

  // 初始化锁退场：哈希存在性即锁，不再写 admin_initialized
  assert.strictEqual(db.getConfig('admin_initialized'), null);
  assert.strictEqual(install.needsInstall(), false);
});

test('安装完成后：页面恢复（/ 与 /admin 200、/install 锁定视图仍可达）、管理面 API 恢复鉴权', async () => {
  assert.strictEqual((await request(app).get('/')).status, 200);
  assert.strictEqual((await request(app).get('/admin')).status, 200);
  assert.strictEqual((await request(app).get('/install')).status, 200);
  const agents = await request(app).get('/api/admin/2fa/status');
  assert.strictEqual(agents.status, 401, '管理面应恢复为自身鉴权（401），不再是 404 not_found');
});

test('安装完成后：一次性回显的明文 Token 可直接登录', async () => {
  const res = await request(app).post('/api/login')
    .set({ ...PROTO, 'X-Forwarded-For': '203.0.113.210' })
    .send({ token: issuedToken });
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers['set-cookie'], '应下发会话 Cookie');
});

// ---- custom 模式端到端（子进程）：单进程内 state 已 completed，无法二次安装 ----

test('e2e：custom 模式完整安装流程（子进程）', { timeout: 25000 }, async () => {
  const { spawn } = require('child_process');
  const PORT = 38117;
  // 子进程库必须从干净状态起步，否则上一次异常中断留下的"已安装"会让 required 恒为 false
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync('/tmp/diting-install-e2e-custom.db' + suffix); } catch { /* 不存在则忽略 */ }
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_ALLOW_HTTP: '1',
      DB_PATH: '/tmp/diting-install-e2e-custom.db',
      // 指向不可写路径：本用例断言"向导完全不再触碰 .env"
      DITING_ENV_PATH: '/proc/diting-install-e2e/x.env',
      ADMIN_TOKEN: '',
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    // 等待子进程就绪（未安装状态）
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      await new Promise(r => setTimeout(r, 100));
      try {
        const r = await fetch(`${base}/api/install/status`);
        if (r.ok) ready = (await r.json()).required === true;
      } catch { /* 未就绪，继续等 */ }
    }
    assert.ok(ready, '子进程应在 5s 内进入未安装就绪状态');

    const res = await fetch(`${base}/api/install/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({
        sitename: '自定义面板',
        description: 'e2e',
        site_url: 'https://pt.example.com',
        agent_server_url: 'https://pt.example.com',
        token_mode: 'custom',
        token: 'diting-e2e-token-9f8e7d6c5b',
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.token, '', 'custom 模式不回显 Token');

    // 完成后管理面 API 恢复（401 而非 404 not_found）
    const afterRes = await fetch(`${base}/api/admin/2fa/status`);
    assert.strictEqual(afterRes.status, 401);

    // 自定义 Token 立即可登录（哈希入库即生效，无需重启/重建容器）
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ token: 'diting-e2e-token-9f8e7d6c5b' }),
    });
    assert.strictEqual(login.status, 200, '自定义 Token 应可直接登录');
  } finally {
    child.kill('SIGKILL');
  }
});
