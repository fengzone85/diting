'use strict';
// 安装向导（复刻 komari install wizard）行为测试：
//   未安装拦截（页面 307 → /install、管理面 403、agent/SETUP_TOKEN 面放行）、
//   complete 校验（sitename/description/自定义 Token 强度）、
//   .env 写失败回滚初始化锁、成功安装的持久化与「安装后锁定」。
//
// 运行前提（必须在 require('../server') 之前设置，与其它集成测试一致）：
//   PORT=0 / ADMIN_ALLOW_HTTP=1 / DB_PATH 指向 /tmp 临时库；
//   故意不设 ADMIN_TOKEN（未安装正是被测主体）；DITING_ENV_PATH 把 .env 写入
//   重定向到 /tmp，绝不触碰真实 server/.env。

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.DB_PATH = '/tmp/diting-install-wizard-test.db';
delete process.env.ADMIN_TOKEN;
process.env.DITING_ENV_PATH = '/tmp/diting-install-wizard-test.env';

const fs = require('fs');
const path = require('path');

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

// complete 端点有 60s/5 次的 IP 限流；测试进程同源同 IP，逐用例轮换 X-Forwarded-For
// （TRUST_PROXY 默认采信 loopback 代理的 XFF）避免配额串扰。
let xffSeq = 100;
const XFF = () => ({ ...PROTO, 'X-Forwarded-For': `203.0.113.${xffSeq++}` });

after(async () => {
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  // 清理本测试留下的凭据与临时文件，避免泄漏进同进程后续测试或污染工作区
  delete process.env.ADMIN_TOKEN;
  if (createdIndex) { try { fs.unlinkSync(INDEX_HTML); } catch { /* ignore */ } }
  for (const f of [process.env.DITING_ENV_PATH, '/tmp/diting-install-e2e-custom.env', '/tmp/diting-install-e2e-custom.db']) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

// ---- 未安装状态：探测端点与拦截 ----

test('GET /api/install/status：未安装 → required=true、state=ready', async () => {
  const res = await request(app).get('/api/install/status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.required, true);
  assert.strictEqual(res.body.state, 'ready');
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

test('未安装时管理面 API → 403 installation_required', async () => {
  const agents = await request(app).get('/api/admin/agents');
  assert.strictEqual(agents.status, 403);
  assert.strictEqual(agents.body.error, 'installation_required');
  const login = await request(app).post('/api/login').send({ token: 'x' });
  assert.strictEqual(login.status, 403);
  assert.strictEqual(login.body.error, 'installation_required');
});

test('未安装时 agent 面 / SETUP_TOKEN 注册 / 旧 setup 端点不受拦截', async () => {
  // 公开 v1 面正常响应（非 403 installation_required 即放行）
  const v1 = await request(app).get('/api/v1/nodes');
  assert.notStrictEqual(v1.status, 403);
  assert.notStrictEqual(v1.body.error, 'installation_required');
  // SETUP_TOKEN 未配置是业务层拒绝（而非 installGate 拦截），证明注册入口穿透了拦截
  const reg = await request(app).post('/api/setup/register').send({ setup_token: 'x' });
  assert.notStrictEqual(reg.body.error, 'installation_required');
  // 旧 setup/status 兼容端点仍工作
  const st = await request(app).get('/api/setup/status');
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.body.needs_setup, true);
});

// ---- complete 请求校验（对应 komari completeRequest 校验）----

test('complete：sitename 缺失/超长 → 400 invalid_sitename', async () => {
  const missing = await request(app).post('/api/install/complete').set(XFF()).send({ token_mode: 'generate' });
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(missing.body.error, 'invalid_sitename');
  const tooLong = await request(app).post('/api/install/complete').set(XFF())
    .send({ sitename: 'x'.repeat(101), token_mode: 'generate' });
  assert.strictEqual(tooLong.status, 400);
  assert.strictEqual(tooLong.body.error, 'invalid_sitename');
});

test('complete：description 超长 → 400 invalid_description', async () => {
  const res = await request(app).post('/api/install/complete').set(XFF())
    .send({ sitename: 'ok', description: 'x'.repeat(1001), token_mode: 'generate' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'invalid_description');
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
    const res = await request(app).post('/api/install/complete').set(XFF())
      .send({ sitename: 'ok', token_mode: 'custom', token });
    assert.strictEqual(res.status, 400, `token=${JSON.stringify(token)} 应被拒绝`);
    assert.strictEqual(res.body.error, 'weak_token');
  }
  // 校验失败不得消耗内存状态机与 DB 锁
  const st = await request(app).get('/api/install/status');
  assert.strictEqual(st.body.state, 'ready');
  assert.strictEqual(db.getConfig('admin_initialized'), null);
});

// ---- 写 .env 失败：回滚初始化锁，向导保持可重试（对应 komari 安装失败回滚语义）----

test('complete：.env 写失败 → 500 write_failed、锁回滚、重试成功', async () => {
  const prev = process.env.DITING_ENV_PATH;
  process.env.DITING_ENV_PATH = '/proc/diting-install-nonexistent/x.env'; // 必然写失败
  try {
    const bad = await request(app).post('/api/install/complete').set(XFF())
      .send({ sitename: '回滚测试', token_mode: 'generate' });
    assert.strictEqual(bad.status, 500);
    assert.strictEqual(bad.body.error, 'write_failed');
    assert.strictEqual(db.getConfig('admin_initialized'), null, 'admin_initialized 锁应被回滚');
    assert.strictEqual(db.getUiSettings().site_title, '', '站点信息不应被写入');
    assert.strictEqual(install.needsInstall(), true, '进程 env 不应被部分更新');
  } finally {
    process.env.DITING_ENV_PATH = prev;
  }
  const ok = await request(app).post('/api/install/complete').set(XFF())
    .send({ sitename: '回滚测试', token_mode: 'generate' });
  assert.strictEqual(ok.status, 200, '回滚后向导仍可用');
  // 回滚用例已成功安装，后续断言依赖状态翻转
  assert.match(ok.body.token, /^adm_[0-9a-f]{32}$/);
});

// ---- custom 模式端到端（子进程）：单进程内 state 已 completed，无法二次安装 ----

test('e2e：custom 模式完整安装流程（子进程）', { timeout: 20000 }, async () => {
  const { spawn } = require('child_process');
  const PORT = 38117;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_ALLOW_HTTP: '1',
      DB_PATH: '/tmp/diting-install-e2e-custom.db',
      DITING_ENV_PATH: '/tmp/diting-install-e2e-custom.env',
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
        token_mode: 'custom',
        token: 'diting-e2e-token-9f8e7d6c5b',
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.token, '', 'custom 模式不回显 Token');

    const env = fs.readFileSync('/tmp/diting-install-e2e-custom.env', 'utf-8');
    assert.ok(env.includes('ADMIN_TOKEN=diting-e2e-token-9f8e7d6c5b'));

    // 完成后管理面 API 恢复（401 而非 403 installation_required）
    const after = await fetch(`${base}/api/admin/2fa/status`);
    assert.strictEqual(after.status, 401);
  } finally {
    child.kill('SIGKILL');
  }
});

// ---- 安装完成后的锁定与恢复（依赖上方「重试成功」已完成安装）----

test('安装完成后：complete → 409（内存状态机）、status 翻转、Token 已入 .env（600）', async () => {
  const again = await request(app).post('/api/install/complete').set(XFF())
    .send({ sitename: '再装一次', token_mode: 'generate' });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.body.error, 'already_completed');

  const st = await request(app).get('/api/install/status');
  assert.strictEqual(st.body.required, false);
  assert.strictEqual(st.body.state, 'completed');

  const stat = fs.statSync(process.env.DITING_ENV_PATH);
  assert.strictEqual(stat.mode & 0o777, 0o600, '.env 权限应为 600');
  const env = fs.readFileSync(process.env.DITING_ENV_PATH, 'utf-8');
  assert.match(env, /^ADMIN_TOKEN=adm_[0-9a-f]{32}$/m);
});

test('安装完成后：页面恢复（/ 与 /admin 200、/install 锁定视图仍可达）、管理面 API 恢复鉴权', async () => {
  assert.strictEqual((await request(app).get('/')).status, 200);
  assert.strictEqual((await request(app).get('/admin')).status, 200);
  assert.strictEqual((await request(app).get('/install')).status, 200);
  const agents = await request(app).get('/api/admin/2fa/status');
  assert.strictEqual(agents.status, 401, '管理面应恢复为自身鉴权（401），不再是 403 installation_required');

  // 站点信息已持久化
  const ui = db.getUiSettings();
  assert.strictEqual(ui.site_title, '回滚测试');
  assert.strictEqual(ui.site_description, '');
});
