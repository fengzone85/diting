'use strict';
// ============================================================
// 后台人用登录改造（密码 / 恢复码 / 记住此设备）回归断言
//
// 覆盖 plans/2026-11-14-admin-human-login.md §5 负向对照与两轮审查动作清单：
//   ① 全局失败计数＝节流（r3/P0-2）：他人失败**不锁死**正确登录，计数持久化、成功清零
//   ② 恢复码消费即删（重放失败）
//   ③ 篡改 cookie payload ⇒ HMAC 校验失败
//   ④ 「未设密码」与「错误 token」响应完全一致（防枚举）
//   ⑤ token 通道回归（X-Admin-Token 全绿）
//   ⑧ 双通道同传 → 400
//   ⑨ 恢复码登录勾选 remember ⇒ 会话仍 12h（P0-5）；TOTP+remember ⇒ 30d
//   r3/P0-1 节点受限 Token 触碰全局凭据 → 403 forbidden_scope
//   r3/P1-2 输错旧密码不白烧恢复码（current_password 先于第二因子校验）
//   r3/P1-2b 2FA 开启时清除密码必须带第二因子
//   另：Max-Age 同源（P0-3）、改密不自踢（P0-1）、prune 双条件（P0-2）、
//       scrypt 往返/弱口令形状（P2-6）、恢复码 Crockford（P2-4）。
//
// 注意：/api/login 有「每 IP 每 60s 最多 5 次」限流（成功也计数），每个用例
// 必须用独立 X-Forwarded-For IP 桶；另有全局节流延迟（失败计数×500ms），
// 用例内避免无谓的连续失败。
// ============================================================

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'human-login-admin-token-0123456789ab';
process.env.DB_PATH = '/tmp/diting-admin-human-login-test.db';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

const {
  hashPassword, verifyPassword, verifyPasswordEqualizing, hashPasswordSync,
  needsRehash, checkPasswordStrength,
  generateRecoveryCodes, normalizeRecoveryCode, recoveryCodeHash,
  SCRYPT_N, RECOVERY_CODE_ALPHABET,
} = require('../src/password');

const HTTPS = { 'X-Forwarded-Proto': 'https' };
// 每用例独立 IP 桶（loginRateLimit 5/60s 按 IP 计数，成功也占额度）
const ip = (n) => ({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': `203.0.113.${n}` });

let app;
let server;
let db;
let auth;
let totpMod;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

before(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
  }
  const srv = require('../server');
  app = srv.app;
  server = srv.server;
  db = require('../src/db');
  auth = require('../src/auth');
  totpMod = require('../src/totp');
});

after(async () => {
  try { require('../src/alerts').stop(); } catch { /* 忽略 */ }
  try { require('../src/ai').stop(); } catch { /* 忽略 */ }
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// r5/P1-2：用例间状态复位——此前一条失败会级联污染后续（2FA 残留/密码残留/计数残留
// 让三条用例连坐变红）。每个用例自洽：需要密码的用例自己设（ensurePassword）。
beforeEach(() => {
  db.set2FAEnabled(false);
  try { db.set2FASecret(''); } catch { /* 忽略 */ }
  db.clearAdminPasswordHash();
  db.clearLoginGuardGlobal();
  const { _loginGuardState } = require('../src/ratelimit');
  _loginGuardState.clear();
});

// 自洽辅助：用 token 通道设初设密码（beforeEach 已清密码 ⇒ 无 current_password 门槛）。
async function ensurePassword(pw) {
  const r = await request(app)
    .post('/api/admin/password').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN })
    .send({ password: pw });
  assert.equal(r.status, 200, `ensurePassword 失败: ${JSON.stringify(r.body)}`);
}

// ---- 纯函数：scrypt 密码 ----

test('scrypt 往返：异步/同步一致、错误密码拒、参数随串入库', async () => {
  const h = await hashPassword('correct-horse-battery');
  assert.ok(h.startsWith(`scrypt$${SCRYPT_N}$`), `格式应含默认参数: ${h.slice(0, 30)}`);
  assert.ok(await verifyPassword('correct-horse-battery', h));
  assert.ok(!await verifyPassword('wrong-horse-battery', h));
  assert.ok(!await verifyPassword('correct-horse-battery', 'garbage'));
  const hs = hashPasswordSync('correct-horse-battery');
  assert.ok(await verifyPassword('correct-horse-battery', hs), '同步哈希应可被异步校验');
});

test('verifyPasswordEqualizing：未设密码恒 false（且内部跑 dummy scrypt 抹平时序）', async () => {
  assert.strictEqual(await verifyPasswordEqualizing('whatever-long-enough', ''), false);
  assert.strictEqual(await verifyPasswordEqualizing('whatever-long-enough', null), false);
  const h = await hashPassword('real-password-123');
  assert.strictEqual(await verifyPasswordEqualizing('real-password-123', h), true);
});

test('needsRehash：弱参数判升级、默认参数不升级', () => {
  const weak = hashPasswordSync('some-long-password', { N: 1024, r: 8, p: 1 });
  assert.ok(needsRehash(weak), 'N=1024 应判弱');
  const strong = hashPasswordSync('some-long-password');
  assert.ok(!needsRehash(strong), '当前默认参数不应再 rehash');
});

test('密码强度（P2-6）：长度/纯数字/字符种类/连续序列/禁用值', () => {
  assert.ok(!checkPasswordStrength('short').ok);
  assert.ok(checkPasswordStrength('twelve-chars').ok);
  assert.ok(!checkPasswordStrength('x'.repeat(1025)).ok);
  assert.ok(!checkPasswordStrength('123456789012').ok, '纯数字应拒');
  assert.ok(!checkPasswordStrength('aabbccddaabb').ok, '字符种类过少应拒');
  assert.ok(!checkPasswordStrength('xxabcd123456').ok, '含连续序列应拒');
  assert.ok(!checkPasswordStrength('adm_0123456789abcdef', { reject: 'adm_0123456789abcdef' }).ok, '与 Token 同值应拒');
});

// ---- 纯函数：恢复码（P2-4 Crockford）----

test('恢复码：Crockford 字符集、规范化（I/L→1、O→0）、哈希稳定、不重复', () => {
  const codes = generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, '不应重复');
  const crockford = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
  for (const c of codes) {
    assert.match(c, crockford);
    for (const ch of c.replace(/-/g, '')) assert.ok(RECOVERY_CODE_ALPHABET.includes(ch), `字符 ${ch} 不在 Crockford 集`);
  }
  const c = codes[0];
  assert.equal(normalizeRecoveryCode(c.toLowerCase().replace(/-/g, ' ')), c.replace(/-/g, ''));
  assert.equal(normalizeRecoveryCode('IIII-LLLL-OOOO'), '111111110000', '易混字符应归一');
  assert.equal(recoveryCodeHash(c), recoveryCodeHash(c.toLowerCase()));
  assert.equal(recoveryCodeHash('!!!bad!!!'), '', '非法输入返回空哈希');
});

// ---- cookie 安全（P0-3 / 负向对照③）----

test('篡改 cookie payload ⇒ 校验失败；合法签名可解出 exp（Max-Age 同源基础）', () => {
  const exp = Date.now() + 123456;
  const cookie = auth.signSession({ role: 'admin', exp, via: 'password' });
  const ok = auth.verifySession(cookie);
  assert.ok(ok && ok.exp === exp && ok.via === 'password');
  const [, sig] = cookie.split('.');
  const tamperedBody = Buffer.from(JSON.stringify({ role: 'admin', exp: exp + 999999, via: 'password' })).toString('base64url');
  assert.equal(auth.verifySession(`${tamperedBody}.${sig}`), null, '篡改 exp 必须校验失败');
});

test('setSessionCookie：Max-Age 由 payload.exp 推导（remember=30d / 无 exp 兜底 12h）', () => {
  const mockRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });
  const r1 = mockRes();
  auth.setSessionCookie(r1, { role: 'admin', exp: Date.now() + 30 * 24 * 3600 * 1000 });
  const ma1 = Number(/Max-Age=(\d+)/.exec(String(r1.headers['Set-Cookie']))[1]);
  assert.ok(ma1 > 29 * 24 * 3600 && ma1 <= 30 * 24 * 3600, `remember Max-Age=${ma1}`);
  const r2 = mockRes();
  auth.setSessionCookie(r2, { role: 'admin', iat: Date.now() }); // 旧调用无 exp
  const ma2 = Number(/Max-Age=(\d+)/.exec(String(r2.headers['Set-Cookie']))[1]);
  assert.ok(ma2 > 11 * 3600 && ma2 <= 12 * 3600, `兜底 Max-Age=${ma2}`);
});

// ---- 登录接口（防枚举 / 双通道 / remember 规则）----

test('双通道同传 → 400；都不传 → 401', async () => {
  const both = await request(app).post('/api/login').set(ip(11)).send({ token: 't', password: 'p' });
  assert.equal(both.status, 400);
  assert.equal(both.body.error, 'ambiguous credentials');
  const none = await request(app).post('/api/login').set(ip(11)).send({});
  assert.equal(none.status, 401);
});

test('负向对照④：未设密码时 password 通道与错误 token 通道响应完全一致', async () => {
  const byPassword = await request(app).post('/api/login').set(ip(12)).send({ password: 'whatever-long-enough' });
  const byToken = await request(app).post('/api/login').set(ip(12)).send({ token: 'definitely-wrong-token' });
  assert.equal(byPassword.status, 401);
  assert.equal(byToken.status, 401);
  assert.deepEqual(byPassword.body, byToken.body, '两通道 401 响应体必须逐字段一致');
  assert.equal(byPassword.body.error, 'invalid credentials');
});

test('负向对照⑤+remember：token 登录成功但不给长会话（Max-Age≈12h）', async () => {
  const res = await request(app).post('/api/login').set(ip(13)).send({ token: ADMIN_TOKEN, remember: true });
  assert.equal(res.status, 200);
  const cookie = String(res.headers['set-cookie']);
  const ma = Number(/Max-Age=(\d+)/.exec(cookie)[1]);
  assert.ok(ma <= 12 * 3600 + 60, `token 通道不应发长会话 Max-Age=${ma}`);
});

test('password 通道：设密码 → 勾 remember 发 30d 会话 → 改密踢其它会话保当前（P0-1/P0-5）', async () => {
  const H = ip(14);
  // 1) token 通道设初设密码（无 current_password）
  const set = await request(app)
    .post('/api/admin/password').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN })
    .send({ password: 'first-long-password' });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  // 2) 密码登录（勾 remember）→ 30d 会话（未开 2FA 也允许，r2 拍板）
  const loginA = await request(app).post('/api/login').set(H)
    .send({ password: 'first-long-password', remember: true });
  assert.equal(loginA.status, 200);
  const maA = Number(/Max-Age=(\d+)/.exec(String(loginA.headers['set-cookie']))[1]);
  assert.ok(maA > 29 * 24 * 3600, `remember 会话应≈30d Max-Age=${maA}`);
  const cookieA = String(loginA.headers['set-cookie']).split(';')[0];

  // 3) 第二台设备登录（不勾 remember）
  const loginB = await request(app).post('/api/login').set(H)
    .send({ password: 'first-long-password' });
  assert.equal(loginB.status, 200);
  const cookieB = String(loginB.headers['set-cookie']).split(';')[0];

  // 3b) 改密缺/错 current_password → 401（不改密、不踢会话）
  const noCurrent = await request(app).post('/api/admin/password').set(H).set('Cookie', cookieB)
    .send({ password: 'second-long-password' });
  assert.equal(noCurrent.status, 401, '缺 current_password 必须拒绝');
  const wrongCurrent = await request(app).post('/api/admin/password').set(H).set('Cookie', cookieB)
    .send({ password: 'second-long-password', current_password: 'not-the-password' });
  assert.equal(wrongCurrent.status, 401, 'current_password 错必须拒绝');

  // 4) 用设备 B 改密 → 踢 A、保 B
  const change = await request(app)
    .post('/api/admin/password').set(H).set('Cookie', cookieB)
    .send({ password: 'second-long-password', current_password: 'first-long-password' });
  assert.equal(change.status, 200, JSON.stringify(change.body));
  assert.equal(change.body.kicked_sessions, 1, '应只踢其它 1 台');

  // 5) A 被踢（401），B 仍有效（200）
  const afterA = await request(app).get('/api/admin/password').set(H).set('Cookie', cookieA);
  assert.equal(afterA.status, 401, '被踢设备必须 401');
  const afterB = await request(app).get('/api/admin/password').set(H).set('Cookie', cookieB);
  assert.equal(afterB.status, 200, '改密设备自身不得被踢（P0-1 不自踢）');

  // 6) 旧密码失效、新密码可登录
  const oldLogin = await request(app).post('/api/login').set(ip(15)).send({ password: 'first-long-password' });
  assert.equal(oldLogin.status, 401);
  const newLogin = await request(app).post('/api/login').set(ip(15)).send({ password: 'second-long-password' });
  assert.equal(newLogin.status, 200);
});

test('弱口令设密码 → 400（P2-6）', async () => {
  const weak = await request(app)
    .post('/api/admin/password').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN })
    .send({ password: '123456789012' });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error, 'weak_password');
});

test('未鉴权 GET /api/admin/password 不可达（无 presence 泄露）', async () => {
  const res = await request(app).get('/api/admin/password').set(ip(16));
  assert.equal(res.status, 401);
});

test('r3/P0-1：节点受限 Token 触碰全局密码凭据 → 403 forbidden_scope', async () => {
  // 造一个真实节点（受限 Token 的 agent_ids 会校验存在性），再签发 scope=admin + 单节点白名单 Token
  const agent = db.createAgent({ name: 'scoped-probe-node' });
  const created = await request(app)
    .post('/api/admin/api-tokens').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN })
    .send({ name: 'scoped-probe', scope: 'admin', agent_ids: [agent.id] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const scoped = created.body.token;
  const H = { ...HTTPS, 'X-API-Token': scoped };

  const g = await request(app).get('/api/admin/password').set(H);
  assert.equal(g.status, 403, '受限 Token 读 presence 也必须 403');
  assert.equal(g.body.error, 'forbidden_scope');

  const p = await request(app).post('/api/admin/password').set(H)
    .send({ password: 'attacker-chosen-pass' });
  assert.equal(p.status, 403, '受限 Token 设密码必须 403（防越权接管）');
  assert.equal(p.body.error, 'forbidden_scope');

  const c = await request(app).post('/api/admin/password/clear').set(H).send({});
  assert.equal(c.status, 403, '受限 Token 清密码必须 403');

  // 对照组：全局设置端点同样拦截（既有惯例）
  const s = await request(app).put('/api/settings').set(H).send({});
  assert.equal(s.status, 403);
});

// ---- 2FA + 恢复码（负向对照②⑨、P1-2、§3.7 救援链）----

test('2FA/恢复码全链：TOTP+remember=30d、恢复码禁 remember、重放拒绝、错旧密码不烧恢复码、恢复码关 2FA', async () => {
  await ensurePassword('second-long-password'); // 自洽：beforeEach 已清密码（P1-2）
  // 1) setup → enable（用真 TOTP 码）
  const setup = await request(app)
    .post('/api/admin/2fa/setup').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN }).send({});
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const secret = setup.body.secret;
  const enable = await request(app)
    .post('/api/admin/2fa/enable').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN })
    .send({ code: totpMod.totp(secret) });
  assert.equal(enable.status, 200, JSON.stringify(enable.body));
  const codes = enable.body.recovery_codes;
  assert.ok(Array.isArray(codes) && codes.length === 10, '启用应返回 10 个恢复码');

  // 2) TOTP 登录 + remember → 30d（规则①）。
  // enable 刚消费过当前时间步（verifyTotpOnce 防重放），必须用下一时间步的码。
  // r5/P1-1：用 timestamp 对齐取码（+30s 恒等于 counter+1，30 相位全过）——
  // 旧「Date.now+35s」手法在周期后段（相位>25s）会跨到 counter+2 落出 ±1 窗口，16.7% 概率 401。
  const nextStepCode = totpMod.totp(secret, { timestamp: Date.now() + 30000 });
  const totpLogin = await request(app).post('/api/login').set(ip(21))
    .send({ password: 'second-long-password', totp: nextStepCode, remember: true });
  assert.equal(totpLogin.status, 200, JSON.stringify(totpLogin.body));
  const maTotp = Number(/Max-Age=(\d+)/.exec(String(totpLogin.headers['set-cookie']))[1]);
  assert.ok(maTotp > 29 * 24 * 3600, `TOTP 登录 + remember 应 30d，Max-Age=${maTotp}`);

  // 3) 恢复码登录（勾 remember 也不给长会话，负向对照⑨）
  const login = await request(app).post('/api/login').set(ip(21))
    .send({ password: 'second-long-password', totp: codes[0], remember: true });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const ma = Number(/Max-Age=(\d+)/.exec(String(login.headers['set-cookie']))[1]);
  assert.ok(ma <= 12 * 3600 + 60, `恢复码登录必须 12h，Max-Age=${ma}`);

  // 4) 同码重放 → 401（负向对照②）
  const replay = await request(app).post('/api/login').set(ip(21))
    .send({ password: 'second-long-password', totp: codes[0] });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.need_totp, true);

  // 5) r3/P1-2：改密输错 current_password + 恢复码 → 401 且恢复码**不被烧**
  const badChange = await request(app)
    .post('/api/admin/password').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN })
    .send({ password: 'third-long-password', current_password: 'wrong-old-password', totp: codes[1] });
  assert.equal(badChange.status, 401);
  assert.equal(badChange.body.error, 'invalid current password');
  const codeStillGood = await request(app).post('/api/login').set(ip(22))
    .send({ password: 'second-long-password', totp: codes[1] });
  assert.equal(codeStillGood.status, 200, '旧密码打错不得白烧恢复码（P1-2）');

  // 6) 2FA 开启时清除密码不带第二因子 → 401 need_totp（P1-2b）
  const clearNoF = await request(app)
    .post('/api/admin/password/clear').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN }).send({});
  assert.equal(clearNoF.status, 401);
  assert.equal(clearNoF.body.need_totp, true);

  // 7) 恢复码关闭 2FA（TOTP 设备丢失救援路径，§3.7）
  const disable = await request(app)
    .post('/api/admin/2fa/disable').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN })
    .send({ code: codes[2] });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));
  const st = await request(app).get('/api/admin/2fa/status').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN });
  assert.equal(st.body.enabled, false, '恢复码必须能关 2FA');

  // 8) 关闭后旧恢复码无第二因子语义：2FA 已关，凭密码即登录
  const stale = await request(app).post('/api/login').set(ip(21))
    .send({ password: 'second-long-password', totp: codes[3] });
  assert.equal(stale.status, 200, '2FA 已关时密码单因子可登录（恢复码残留无害）');
});

// ---- 全局失败计数＝节流（r3/P0-2）----

test('r3/P0-2：他人失败不锁死正确登录（节流无封禁）、计数持久化、成功清零', async () => {
  await ensurePassword('second-long-password'); // 自洽（P1-2）
  // 三个不同 IP 打错密码（分布式猜测形态）
  for (const n of [41, 42, 43]) {
    const r = await request(app).post('/api/login').set(ip(n)).send({ password: 'wrong-password-guess' });
    assert.equal(r.status, 401);
  }
  const rec = db.getLoginGuardGlobal();
  assert.ok(rec && (rec.fails || 0) >= 3, `失败计数应落库: ${JSON.stringify(rec)}`);

  // 关键断言：另一 IP 的**正确密码**必须能登录（绝不封禁，最多节流延迟）
  const legit = await request(app).post('/api/login').set(ip(44))
    .send({ password: 'second-long-password' });
  assert.equal(legit.status, 200, '他人失败不得锁死合法登录（P0-2）');

  // 成功清零
  const after = db.getLoginGuardGlobal();
  assert.ok(!after || !after.fails, `成功后计数应清零: ${JSON.stringify(after)}`);
});

// ---- prune 双条件（P0-2 会话侧）----

test('prune 双条件：expires_at 到期删；无 expires_at 走旧 TTL；30d 会话不被 24h 规则误删', () => {
  const now = Date.now();
  const legacyBefore = now - 24 * 3600 * 1000;

  const sidA = db.createSessionRow({ ip: '1.2.3.4', ua: 'A', expiresAt: now + 27 * 24 * 3600 * 1000, remember: true });
  const sidB = db.createSessionRow({ ip: '1.2.3.5', ua: 'B' });
  const sidC = db.createSessionRow({ ip: '1.2.3.6', ua: 'C', expiresAt: now - 1000, remember: true });
  db.db.prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(now - 3 * 24 * 3600 * 1000, sidA);
  db.db.prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(now - 3 * 24 * 3600 * 1000, sidB);

  db.pruneSessions(now, legacyBefore);
  assert.ok(db.getSessionRow(sidA), '30d 会话不活动 3 天也不该被 prune（P0-2）');
  assert.equal(db.getSessionRow(sidB), null, '旧格式行按 24h TTL 删除');
  assert.equal(db.getSessionRow(sidC), null, '到期 remember 会话删除');
});

// ---- 清理（清密码，回到纯 Token）----

test('清除密码回到纯 Token（POST /api/admin/password/clear）', async () => {
  await ensurePassword('second-long-password'); // 自洽（P1-2）
  const res = await request(app)
    .post('/api/admin/password/clear').set({ ...HTTPS, 'X-Admin-Token': ADMIN_TOKEN }).send({});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const login = await request(app).post('/api/login').set(ip(31)).send({ password: 'second-long-password' });
  assert.equal(login.status, 401, '密码清除后 password 通道必须 401');
  const tokenLogin = await request(app).post('/api/login').set(ip(31)).send({ token: ADMIN_TOKEN });
  assert.equal(tokenLogin.status, 200, 'token 通道不受影响');
});
