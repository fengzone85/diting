'use strict';
// ============================================================
// 会话 Cookie 属性一致性（安全回归）
//
// 真实缺陷（2026-10-26 核实并修复）：
//   注销 Cookie 原先**硬编码** `Secure;`，而登录在 `ADMIN_ALLOW_HTTP=1`
//   （http 部署，例如内网直连 http://192.168.x.x:8081）下不附加 Secure。
//   浏览器判定 cookie 身份包含属性集合 ⇒ 注销下发的「带 Secure 的空 cookie」
//   与登录下发的「不带 Secure 的会话 cookie」是两个不同的 cookie，
//   于是**退出登录后原会话 cookie 仍留在浏览器里，会话实际仍然有效**。
//
// 本测试把「登录与注销的属性必须逐字一致（除 Max-Age）」固化成断言，
// 防止将来只改一处又把这洞打开。
// ============================================================
const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const auth = require('../src/auth');

const mockRes = () => ({
  headers: {},
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
});

// 取 Set-Cookie 里的属性段（去掉 name=value 与 Max-Age 的具体值）
function attrsOf(res) {
  const raw = String(res.headers['set-cookie'] || '');
  const i = raw.indexOf(';');
  assert.ok(i > 0, `Set-Cookie 格式异常: ${raw}`);
  return raw.slice(i + 1)
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !/^Max-Age=/i.test(x))
    .sort()
    .join('; ');
}

const ORIGINAL_ALLOW_HTTP = process.env.ADMIN_ALLOW_HTTP;
afterEach(() => {
  if (ORIGINAL_ALLOW_HTTP === undefined) delete process.env.ADMIN_ALLOW_HTTP;
  else process.env.ADMIN_ALLOW_HTTP = ORIGINAL_ALLOW_HTTP;
});

function loginAndLogout() {
  const loginRes = mockRes();
  auth.setSessionCookie(loginRes, { role: 'admin', iat: Date.now() });
  const logoutRes = mockRes();
  auth.clearSessionCookie(logoutRes);
  return { loginRes, logoutRes };
}

test('默认（https 部署）：登录与注销都带 Secure，且属性逐字一致', () => {
  delete process.env.ADMIN_ALLOW_HTTP;
  const { loginRes, logoutRes } = loginAndLogout();
  const login = attrsOf(loginRes);
  const logout = attrsOf(logoutRes);
  assert.match(login, /Secure/, '登录 cookie 应带 Secure');
  assert.match(logout, /Secure/, '注销 cookie 应带 Secure');
  assert.strictEqual(login, logout, '登录与注销的 cookie 属性必须完全一致（除 Max-Age）');
});

test('ADMIN_ALLOW_HTTP=1（http 部署）：两者都不带 Secure —— 这是修复前的漏洞场景', () => {
  process.env.ADMIN_ALLOW_HTTP = '1';
  const { loginRes, logoutRes } = loginAndLogout();
  const login = attrsOf(loginRes);
  const logout = attrsOf(logoutRes);
  assert.doesNotMatch(login, /Secure/, 'http 部署下登录 cookie 不应带 Secure');
  assert.doesNotMatch(logout, /Secure/, 'http 部署下注销 cookie 也不应带 Secure（否则覆盖不掉旧 cookie）');
  assert.strictEqual(login, logout, '登录与注销的 cookie 属性必须完全一致（除 Max-Age）');
});

test('注销 cookie 的 Max-Age 必须为 0（清空），登录则为正数', () => {
  process.env.ADMIN_ALLOW_HTTP = '1';
  const { loginRes, logoutRes } = loginAndLogout();
  assert.match(String(logoutRes.headers['set-cookie']), /Max-Age=0/);
  const m = String(loginRes.headers['set-cookie']).match(/Max-Age=(\d+)/);
  assert.ok(m && Number(m[1]) > 0, '登录 cookie 的 Max-Age 应为正数');
});

test('cookie 名固定，且 HttpOnly / SameSite 始终存在', () => {
  for (const httpMode of [undefined, '1']) {
    if (httpMode === undefined) delete process.env.ADMIN_ALLOW_HTTP;
    else process.env.ADMIN_ALLOW_HTTP = httpMode;
    const { loginRes, logoutRes } = loginAndLogout();
    for (const res of [loginRes, logoutRes]) {
      const raw = String(res.headers['set-cookie']);
      assert.ok(raw.startsWith(`${auth.COOKIE_NAME}=`), 'cookie 名应与 COOKIE_NAME 一致');
      assert.match(raw, /HttpOnly/);
      assert.match(raw, /SameSite=Strict/);
      assert.match(raw, /Path=\//);
    }
  }
});
