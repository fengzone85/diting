'use strict';
// 认证与会话域：初始化向导（/setup/*）、登录 /login、注销 /logout、
// 管理密码 /admin/password（含清除）。由 api.js 原样搬移，行为零变化。

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { loginGuard, loginGuardFail, loginGuardClear } = require('../ratelimit');
const { verifyPassword, verifyPasswordEqualizing, hashPassword, needsRehash, checkPasswordStrength } = require('../password');
const {
  requireAdmin, safeEqual, setSessionCookie, clearSessionCookie, SESSION_TTL, SESSION_REMEMBER_TTL,
  requireProto, auditLog, revokeAllSessions, totpGuard, recordTotpFailure, clearTotpFailures,
  verifySecondFactor, agentScope, getSession, clearSessionCache, resolveRole,
} = require('../auth');
const { hasAdminToken, verifyAdminToken, hashAdminToken } = require('../token-policy');
const { str } = require('../validate');
const { asyncHandler } = require('../util');
const { resolveSetupToken, isWeakSetupToken } = require('../setup-token');
const { loginRateLimit, setupRateLimit, registerRateLimit, loginGuardKey, noteLoginBanned, agentGlobalOnly } = require('./_shared');

const router = express.Router();

// ---- 首次部署初始化向导 ----
router.get('/setup/status', (req, res) => {
  res.json({ needs_setup: !hasAdminToken() });
});
// 初始化端点：仅在「库中无 Token 哈希」时可用。一旦写入，本端点永久失效（返回 410 Gone），
// 后续重置 Token 只能通过 SSH 运行 diting.sh --reset-admin-token，彻底杜绝 Web 重置风险。
// 审查 C-4：初始化端点同样要求经反代的 HTTPS（纯 HTTP 下 Token 会走明文回显）。
// P0：Token **只存 sha256 哈希**，明文仅在本次响应里回显一次；不再写 .env、
// 不再修改进程 env（容器内 /app/.env 不持久，写过一次就会"重启即丢 Token"）。
router.post('/setup/generate', setupRateLimit, (req, res) => {
  // 注意：requireProto 返回 boolean、内部不调 next()，**不能**当中间件挂载
  // （挂载会让请求永久挂起——master 上此处曾如此，端点实际不可用）。
  if (!requireProto(req, res)) return;
  if (hasAdminToken()) {
    return res.status(410).json({
      error: 'already initialized',
      message: '管理员 Token 已存在，本端点已永久禁用。重置 Token 请通过 SSH 运行：sudo bash diting.sh --reset-admin-token'
    });
  }
  const token = 'adm_' + crypto.randomBytes(16).toString('hex');
  try {
    // 原子抢写（INSERT OR IGNORE）：多实例并发时只有一个能落库，其余 410。
    // 这一条同时替代了旧的 admin_initialized 抢锁——"哈希存在"本身就是初始化锁。
    if (!db.setAdminTokenHashIfAbsent(hashAdminToken(token))) {
      return res.status(410).json({
        error: 'already initialized',
        message: '另一实例已完成初始化（Token 哈希已写入）。重置 Token 请通过 SSH 运行：sudo bash diting.sh --reset-admin-token'
      });
    }
    console.log('[setup] 管理员 Token 已生成并以哈希入库（明文仅本次回显），此后 /api/setup/generate 永久禁用');
    res.json({ token });
  } catch (e) {
    console.error('[setup] 写入 Token 哈希失败:', e.message);
    res.status(500).json({ error: 'write_failed', message: '写入管理员 Token 失败，请检查数据库可写性与磁盘空间' });
  }
});


// ---- 一键脚本：受控端自助注册（受 SETUP_TOKEN 守卫）----
// 启用条件：服务端 .env 配置了 SETUP_TOKEN。受控端携带该令牌调用本端点，
// 服务端自动创建客户端并返回 id/token，使 agent 安装做到「只填域名+密钥」。
// 不建立任何指令通道——注册后 agent 仍只上报指标，服务端不持有其任何控制权。
// L-3：即便 SETUP_TOKEN 泄露，也对每个 IP 限流（默认每分钟 10 次），
// 防暴力枚举 agent 名称 / 资源耗尽。全局 rateLimit 已做兜底，此处更严格。
// 限流实现已下沉到 routes/_shared.js（registerRateLimit）。
// SETUP_TOKEN 解析口径见 src/setup-token.js（注册端点专用；安装口令 install_token 已移除）
// SETUP_TOKEN 弱模式拒绝（审查 G4）：长度之外再查熵——纯数字、字符种类过少、
// 含连续序列（1234/abcd/qwer）的"够长但可猜"令牌一律停用注册。
// 判定函数现由 src/setup-token.js 提供。
router.post('/setup/register', registerRateLimit, (req, res) => {
  const { token: setupToken } = resolveSetupToken();
  if (!setupToken) {
    return res.status(403).json({ error: '服务端未启用一键注册（未配置 SETUP_TOKEN）' });
  }
  if (isWeakSetupToken(setupToken)) {
    return res.status(403).json({ error: 'SETUP_TOKEN 过弱（至少 16 字符且需含足够熵：禁用纯数字/极少字符种类/连续序列，建议 openssl rand -hex 16），一键注册已停用' });
  }
  // 单 SETUP_TOKEN 累计注册上限（审查 G4）：令牌泄露时限制 rogue agent 数量。
  const maxAgents = Math.max(1, Number(process.env.SETUP_MAX_AGENTS || 50));
  if (db.getSelfRegisteredCount() >= maxAgents) {
    return res.status(403).json({ error: `self-registration quota exhausted (max ${maxAgents} agents per setup token)` });
  }
  const provided = (req.body && req.body.setup_token) || (req.headers['x-setup-token'] || '').trim();
  if (!provided || !safeEqual(provided, setupToken)) {
    return res.status(401).json({ error: 'invalid setup token' });
  }
  // 审查 G4：自助注册的 agent 默认待管理员确认（SETUP_REQUIRE_APPROVAL=0 可退回旧行为）。
  // 待确认期间 agentAuth 拒绝其上报，且不进入看板/告警/公开页统计。
  const requireApproval = process.env.SETUP_REQUIRE_APPROVAL !== '0';
  const { id, token } = db.createAgent({
    name: str(req.body.name, 100) || undefined,
    note: str(req.body.note, 500),
    pending: requireApproval
  });
  db.bumpSelfRegisteredCount();
  res.json({
    agent_id: id,
    agent_token: token,
    pending: requireApproval,
    message: requireApproval ? 'registered, pending admin approval' : 'registered'
  });
});


// 登录后前端不再持有明文 Admin Token，凭证以 HttpOnly+Secure Cookie 维持，降低 XSS 窃取风险。
// 包 asyncHandler：async 内同步 throw（如 db.is2FAEnabled / totp.verifyTOTP 抛错）会变成
// unhandledRejection，Node ≥15 默认直接杀进程。包裹后转为 next(err) 由错误中间件返回 500 JSON。

// 密码通道全局失败计数（r3/P0-2 改节流语义）：**只计数 + 递增延迟，绝不封禁**。
// r1 曾用 count^4 封禁——在「不分 IP」的全局桶上这等于任意外人换 IP 打 3 次错密码
// 即可锁死面板（实测封禁指数升级、落库跨重启、正确密码也进不来 = 未认证远程 DoS）。
// 现：失败 N 次后密码通道请求延迟 min(N,10)*500ms（异步 sleep，不阻塞事件循环），
// 正确凭据永远可用；分布式猜测由 scrypt 成本 + 线程池并发上限 + 按 IP loginGuard 共同约束。
// 1h 无失败自动过期；登录成功清零；--reset-admin-token / purge 一并清该键。
const GLOBAL_FAIL_TTL_MS = 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function globalLoginFails() {
  const rec = db.getLoginGuardGlobal();
  if (!rec || (rec.expiresAt && rec.expiresAt <= Date.now())) return 0;
  return rec.fails || 0;
}
function bumpGlobalLoginFails() {
  const now = Date.now();
  db.setLoginGuardGlobal({ fails: globalLoginFails() + 1, expiresAt: now + GLOBAL_FAIL_TTL_MS });
}

router.post('/login', loginRateLimit, asyncHandler(async (req, res) => {
  if (!requireProto(req, res)) return; // F2：与管理端点一致，强制经 HTTPS 反代，杜绝明文 Token
  // F9 暴力防护：先查封禁状态（封禁期内直接 429 + Retry-After，不再消耗固定窗口配额语义）。
  const gkey = loginGuardKey(req);
  const gstate = loginGuard(gkey);
  if (!gstate.allowed) {
    res.set('Retry-After', String(gstate.retryAfterSec));
    return res.status(429).json({ error: 'login_blocked', retry_after: gstate.retryAfterSec });
  }
  // r1/§3.2：双通道（token=机器凭据 / password=人用凭据），互斥。
  const { token, password, totp: code, remember } = req.body || {};
  if (token && password) return res.status(400).json({ error: 'ambiguous credentials' });
  if (!token && !password) return res.status(401).json({ error: 'invalid credentials' });
  // r3/P0-2：全局失败计数只做递增延迟（节流），不做封禁——正确凭据永远可用。
  if (password && globalLoginFails() > 0) {
    await sleep(Math.min(globalLoginFails(), 10) * 500);
  }

  let via = '';
  if (token) {
    if (!verifyAdminToken(token)) {
      noteLoginBanned(req, gkey, loginGuardFail(gkey));
      // r1/P1-3 防枚举：token 错与「未设密码/密码错」返回完全一致。
      return res.status(401).json({ error: 'invalid credentials' });
    }
    via = 'token';
  } else {
    const stored = db.getAdminPasswordHash();
    // r1/P1-3 + r3/P1-4 防枚举：未设密码与密码错误在响应体**与耗时**上完全一致
    //（verifyPasswordEqualizing 未设密码时也跑一次 dummy scrypt）。
    const ok = await verifyPasswordEqualizing(password, stored);
    if (!ok) {
      noteLoginBanned(req, gkey, loginGuardFail(gkey));
      bumpGlobalLoginFails();
      return res.status(401).json({ error: 'invalid credentials' });
    }
    db.clearLoginGuardGlobal(); // 成功清零全局失败计数（节流自愈）
    // r1/P1-4：登录成功是唯一允许改写哈希的时机（参数弱于默认则 rehash 升级）。
    if (needsRehash(stored)) {
      try { db.setAdminPasswordHash(await hashPassword(password)); }
      catch (e) { console.error('[login] password rehash failed:', e.message); }
    }
    via = 'password';
  }

  const need = db.is2FAEnabled();
  let second = null;
  if (need) {
    // 失败节流（L-2）：与 adminOnly 同一套锁定，避免经 /login 绕过枚举防护。
    if (!totpGuard(req)) {
      return res.status(429).json({ error: 'too many totp failures', need_totp: true });
    }
    // 统一第二因子：TOTP 或一次性恢复码（消费即删行，§3.3）。
    second = verifySecondFactor(code, req);
    if (!second) {
      recordTotpFailure(req);
      noteLoginBanned(req, gkey, loginGuardFail(gkey));
      if (password) bumpGlobalLoginFails();
      return res.status(401).json({ error: 'invalid second factor', need_totp: true });
    }
    clearTotpFailures(req);
  }

  // 登录成功：清零失败计数与封禁（管理员自输错后不必再等封禁结束）。
  loginGuardClear(gkey);
  if (password) db.clearLoginGuardGlobal();

  // remember 签发规则（r1/P0-5）：
  //   ① password 通道 + 勾选 → 30d（第二因子为恢复码时除外）；
  //   ② 恢复码是一次性因子，强制 12h（不得换 30 天免 2FA 高权会话）；
  //   ③ token 通道不给 remember（机器凭据无「设备信任」语义，固定 12h）。
  const wantRemember = !!remember && via === 'password' && second !== 'recovery';
  const ttlMs = wantRemember ? SESSION_REMEMBER_TTL : SESSION_TTL;
  const exp = Date.now() + ttlMs;

  // S2/F6：写会话行并把 sid 放进 cookie payload（此后可按会话粒度踢出）。
  // DB 异常时降级为「不带 sid 的旧格式 cookie」（verifySession 对无 sid 放行），
  // 与会话表的 fail-open 取舍保持一致：不让 DB 故障把管理员挡在门外。
  let sid = '';
  try {
    sid = db.createSessionRow({
      admin: 'admin',
      ip: req.ip || req.socket?.remoteAddress || '',
      ua: req.header('user-agent') || '',
      expiresAt: exp,
      remember: wantRemember,
    });
  } catch (e) {
    console.error('[login] session row creation failed (degraded):', e.message);
  }
  // r1/P0-4：via 写进 payload，审计可区分 password/token 通道。
  const payload = { role: 'admin', totp: need, exp, via };
  if (sid) payload.sid = sid;
  setSessionCookie(res, payload);
  res.json({ ok: true, totp: need });
}));

// 注销：默认「使全部会话失效」（含其他已登录设备），再清当前 Cookie。
// 此前只清 Cookie，已签发的会话在 TTL 内仍然有效（注销无效期）。
// all=0 可退化为仅清当前 Cookie（不影响其他设备）。
// P1-1：全量撤销仅限有效管理员身份（会话或 Admin Token）——匿名请求默认
// revoke all 等于任何人都能把管理员全部踢下线（会话可用性 DoS）并刷审计噪声。
router.post('/logout', (req, res) => {
  const role = resolveRole(req);
  const revokeAll = !!(role && role.role === 'admin') && req.query.all !== '0';
  if (revokeAll) revokeAllSessions();
  clearSessionCookie(res);
  res.json({ ok: true, revoked: revokeAll });
  if (role) auditLog(req, 'logout', revokeAll ? 'all sessions' : '');
});

// ---- 管理密码（人用凭据，§3.1）----
// 三个路由全部挂 agentScope + agentGlobalOnly（r3/P0-1）：节点受限 Token 不得触碰全局
// 凭据——否则「只准看 1 个节点」的 Token 可以给管理员设一个自己知道的密码再登录接管
// （S2/F5 越权路径，与 /admin/settings 等全局端点同惯例）。
// GET：仅已鉴权可读 presence（不提供未鉴权 presence 端点，r1/P1-3 防枚举）。
router.get('/admin/password', requireAdmin, agentScope, agentGlobalOnly, (req, res) => {
  res.json({ set: !!db.getAdminPasswordHash() });
});

// 踢其它会话、保留当前（r1/P0-1：绝不用 revokeAllSessions，水位线会自踢当前会话；
// r3/P2-3 已知残余：历史无 sid 旧 cookie 无法逐个吊销，最长 12h 自然过期，文案已对齐）。
function kickOtherSessions(req) {
  const curSid = (getSession(req) || {}).sid || '';
  const n = db.revokeAllSessionRowsExcept(curSid);
  clearSessionCache();
  return n;
}

// 设置/修改密码。已设密码时必须验 current_password，且**先于**第二因子校验
//（r3/P1-2：输错旧密码不得白烧一次性恢复码）；2FA 开启时第二因子走 verifySecondFactor。
router.post('/admin/password', requireAdmin, agentScope, agentGlobalOnly, asyncHandler(async (req, res) => {
  const body = req.body || {};
  // r3/P2-6：弱口令形状拒绝 + 不得与 Admin Token 相同（调用方明文在手时可校验）。
  // r5/P2-1：reason 机器可读（前端本地化），message 仅兜底。
  const strength = checkPasswordStrength(body.password, { reject: req.header('X-Admin-Token') });
  if (!strength.ok) {
    return res.status(400).json({ error: 'weak_password', reason: strength.reason || '', message: strength.message });
  }
  const stored = db.getAdminPasswordHash();
  if (stored && (!body.current_password || !(await verifyPassword(body.current_password, stored)))) {
    return res.status(401).json({ error: 'invalid current password' });
  }
  if (db.is2FAEnabled()) {
    if (!totpGuard(req)) return res.status(429).json({ error: 'too many totp failures', need_totp: true });
    const f = verifySecondFactor(body.totp || req.header('X-TOTP'), req);
    if (!f) {
      recordTotpFailure(req);
      return res.status(401).json({ error: 'invalid second factor', need_totp: true });
    }
    clearTotpFailures(req);
  }
  db.setAdminPasswordHash(await hashPassword(body.password));
  const n = kickOtherSessions(req);
  auditLog(req, 'admin_password_set', stored ? 'changed' : 'created');
  res.json({ ok: true, kicked_sessions: n });
}));

// 清除密码（回到纯 Token 模式）。POST + body 传第二因子（r3/P1-1：**绝不走 URL query**
// ——nginx combined 日志的 $request 会把 query 明文落 /var/log/nginx/access.log）。
router.post('/admin/password/clear', requireAdmin, agentScope, agentGlobalOnly, (req, res) => {
  if (db.is2FAEnabled()) {
    if (!totpGuard(req)) return res.status(429).json({ error: 'too many totp failures', need_totp: true });
    const f = verifySecondFactor((req.body || {}).totp || req.header('X-TOTP'), req);
    if (!f) {
      recordTotpFailure(req);
      return res.status(401).json({ error: 'invalid second factor', need_totp: true });
    }
    clearTotpFailures(req);
  }
  db.clearAdminPasswordHash();
  const n = kickOtherSessions(req);
  auditLog(req, 'admin_password_clear', '');
  res.json({ ok: true, kicked_sessions: n });
});

module.exports = router;
