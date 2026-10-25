'use strict';
const crypto = require('crypto');
const db = require('./db');
const totp = require('./totp');
// Admin Token 唯一来源：环境变量 ADMIN_TOKEN（.env / Docker / K8s Secret）。
// 废弃 DB / 文件兜底，避免多源不同步导致 Token 架空或残留泄露。
// 强度判定（占位符 / <16 位视为不可用）收敛在 ./token-policy，此处仅再导出。
const { verifyAdminToken } = require('./token-policy');
// IPv6 解析为 128 位 BigInt（S4 起 ratelimit.js 也用它做 /64 归桶，故放 util.js）。
const { ip6ToBits } = require('./util');

// 恒定时间比较，避免令牌比较的时序侧信道。
// 先对两端统一做 SHA-256 哈希再比较固定长度摘要，消除「长度不等提前返回」暴露的
// Token 长度侧信道（审查 v3.1 8.2#4：攻击者原可据此探测 Token 长度）。
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function agentAuth(req, res, next) {
  const id = req.header('X-Agent-ID');
  const auth = req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!id || !token) return res.status(401).json({ error: 'unauthorized' });
  const agent = db.getAgent(id);
  if (!agent) return res.status(403).json({ error: 'unknown agent' });
  if (!safeEqual(db.hashToken(token), agent.token_hash)) return res.status(403).json({ error: 'bad token' });
  // 审查 G4：待确认 agent（自助注册后未经管理员批准）禁止上报。
  // 放在 token 校验之后，避免无 token 者探测"某 id 是否待确认"。
  if (agent.pending) return res.status(403).json({ error: 'agent pending approval' });
  req.agent = agent;
  next();
}

// ---- 签名 Session Cookie（替代前端长期持有明文 Admin Token）----
// 默认 SESSION_SECRET 随机生成（重启即失效，建议 .env 固定）。Cookie 为 HttpOnly+Secure+SameSite=Strict。
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL = Number(process.env.SESSION_TTL_MS || 12 * 3600 * 1000);
const COOKIE_NAME = 'hm_session';

// ---- 服务端会话吊销 ----
// 纯 HMAC 会话是无状态的：已签发 Cookie 在 TTL 内无法撤销（「注销无效期」问题）。
// 这里用 admin_config 里的水位线实现吊销：水位线之前签发（iat）的会话一律无效。
// 粒度为全局（管理员自己的其他标签页也会被踢下），自托管场景下更安全、实现最简。
const SESSION_REVOKED_BEFORE = 'session_revoked_before';

// S2/F6：DB 故障时的取舍——默认 fail-open（签名有效即放行，记错误日志），
// 避免单机 SQLite 损坏把管理员永久锁死；STRICT_SESSION_DB=1 切换 fail-close。
const STRICT_SESSION_DB = process.env.STRICT_SESSION_DB === '1';

// 会话校验缓存（5s）：sessions 表虽小，但每个管理请求都要查一次；缓存把重复查询压到
// 每 sid 每 5 秒一次。吊销时必须调用 clearSessionCache 立即失效，否则被踢出的会话
// 最多还能用 5 秒。缓存条目数有上限（单管理员场景个位数，超限整表清）。
const SESSION_CACHE_TTL_MS = 5000;
const SESSION_CACHE_MAX = 1000;
const _sessionCache = new Map(); // sid → { valid: boolean, at: number }

function sessionCacheGet(sid) {
  const rec = _sessionCache.get(sid);
  if (!rec) return null;
  if (Date.now() - rec.at > SESSION_CACHE_TTL_MS) { _sessionCache.delete(sid); return null; }
  return rec;
}
function sessionCacheSet(sid, valid) {
  if (_sessionCache.size >= SESSION_CACHE_MAX) _sessionCache.clear();
  _sessionCache.set(sid, { valid: !!valid, at: Date.now() });
}
// 吊销后立即失效缓存（sid 省略 = 清空全部）。
function clearSessionCache(sid) {
  if (sid) _sessionCache.delete(sid);
  else _sessionCache.clear();
}

// 使本时刻之前签发的所有会话失效。安全状态变更（2FA 开关）与「退出所有设备」时调用。
function revokeAllSessions() {
  db.setConfig(SESSION_REVOKED_BEFORE, String(Date.now()));
  // S2/F6：同时吊销会话表记录（水位线是兜底，表状态是权威）。
  let n = 0;
  try { n = db.revokeAllSessionRows(); } catch (e) { /* 表不存在/DB 异常时由水位线兜底 */ }
  // 缓存必须同步失效，否则被全局吊销的会话最多还能用 5 秒。
  clearSessionCache();
  return n;
}

function isRevoked(p) {
  const ts = Number(db.getConfig(SESSION_REVOKED_BEFORE) || 0);
  if (!ts) return false;
  // 旧会话无 iat 视为最早签发，一律失效（更安全；仅水位线非 0 时生效）
  return !p.iat || p.iat < ts;
}

function signSession(payload) {
  // iat：签发时间，吊销判断依赖它
  const body = Buffer.from(JSON.stringify(Object.assign({ iat: Date.now() }, payload))).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifySession(cookieVal) {
  if (!cookieVal || !cookieVal.includes('.')) return null;
  const [body, sig] = cookieVal.split('.');
  let expected;
  try { expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url'); }
  catch { return null; }
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    if (isRevoked(p)) return null;
    // S2/F6：会话表校验（单会话踢出）。旧 Cookie 无 sid → 放行至自然过期（兼容）。
    if (p.sid) {
      const cached = sessionCacheGet(p.sid);
      if (cached) {
        // 缓存命中：valid=false 表示该会话已被踢出，直接拒绝
        if (!cached.valid) return null;
      } else {
        try {
          const row = db.getSessionRow(p.sid);
          if (!row || row.revoked) { sessionCacheSet(p.sid, false); return null; }
          db.touchSession(p.sid);
          sessionCacheSet(p.sid, true);
        } catch (e) {
          if (STRICT_SESSION_DB) return null;
          console.error('[auth] session lookup failed (fail-open):', e.message);
        }
      }
    }
    return p;
  } catch { return null; }
}
function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) {
      try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
      catch { /* 畸形 cookie 值（如 %ZZ）跳过，避免 URIError 导致 500 */ }
    }
  });
  return out;
}
function getSession(req) {
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}
function setSessionCookie(res, payload) {
  const cookie = signSession(payload);
  // ADMIN_ALLOW_HTTP=1（仅本地开发直连 http 时启用）下不附加 Secure，
  // 使浏览器可在 http 上下文持有登录态；生产环境不设该变量，cookie 仍强制 Secure。
  const secure = process.env.ADMIN_ALLOW_HTTP === '1' ? '' : 'Secure; ';
  const attrs = `HttpOnly; ${secure}SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${cookie}; ${attrs}`);
}
function clearSessionCookie(res) {
  const attrs = `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${attrs}`);
}

// 协议白名单：仅允许经反向代理且原始请求为 HTTPS 时携带管理类凭证。
// 直连 :8081（无 X-Forwarded-Proto 头、或伪造为 http）一律拒绝，
// 杜绝伪造该头绕过、以及误暴露 8081 端口的情况。
// 本地开发/快速测试如需直连 http，可显式设置 ADMIN_ALLOW_HTTP=1（生产切勿设置）。
//
// 例外：安装向导的 SSH 隧道入口。请求**来自本机或内网**且**没有任何代理头**时放行——
// 公网流量必然经过 nginx，而 nginx 一定会写 X-Forwarded-Proto / X-Real-IP / X-Forwarded-For
// （见 nginx/monitor.conf.example），因此"内网来源 + 零代理头"不可能是公网直连。
// 反向可证：带 X-Forwarded-Proto: http 的请求（即 nginx 转发的明文请求）仍被拒绝。
//
// 为什么不止 127.0.0.1：Docker 部署下端口发布（127.0.0.1:PORT->PORT）经 DNAT 后，
// 容器里看到的来源是**网桥网关 172.17.0.1**，而不是 127.0.0.1。只认回环会让
// 安装器打印的 `ssh -L PORT:127.0.0.1:PORT` 隧道在 Docker 部署下必然 403（T1.9 实测）。
function isPrivateSource(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  if (!a) return false;
  if (a === '::1') return true;
  if (/^127\./.test(a)) return true;                    // 回环
  if (/^10\./.test(a)) return true;                     // 10/8
  if (/^192\.168\./.test(a)) return true;               // 192.168/16
  if (/^169\.254\./.test(a)) return true;               // 链路本地
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true; // 172.16/12（含 docker 网桥）
  if (/^f[cd][0-9a-f]{2}:/i.test(a)) return true;       // IPv6 ULA fc00::/7
  return false;
}

function requireProto(req, res) {
  const proto = (req.header('X-Forwarded-Proto') || '').toLowerCase();
  if (proto === 'https' || process.env.ADMIN_ALLOW_HTTP === '1') return true;
  const h = req.headers || {};
  const viaProxy = h['x-forwarded-for'] || h['x-real-ip'] || h['forwarded'] || h['x-forwarded-proto'];
  if (!viaProxy && isPrivateSource(req.socket && req.socket.remoteAddress)) return true;
  res.status(403).json({ error: 'https required' });
  return false;
}

// 解析请求角色。返回 {role, totp, via, token?} 或 null。
// 优先级：签名 Session Cookie > X-API-Token > X-Admin-Token > X-Readonly-Token。
//
// S2/F5 认证分流（安全边界）：API Token 只认 X-API-Token 头，绝不接受
// Authorization: Bearer —— 后者是 Agent 上报专用通道（agentAuth，X-Agent-ID+Bearer）。
// 从协议层杜绝「同一 Bearer 到底是 Admin 还是 Agent」的歧义：
// Agent Token 泄露无法用于管理路由，反之亦然。
function resolveRole(req) {
  const sess = getSession(req);
  if (sess && sess.role === 'admin') return { role: 'admin', totp: !!sess.totp, via: 'cookie' };
  const apiTok = req.header('X-API-Token');
  if (apiTok) {
    const rec = db.findApiTokenByHash(db.hashToken(apiTok));
    if (rec && !rec.revoked && (!rec.expires_at || rec.expires_at > Date.now())) {
      db.touchApiToken(rec.id, req.ip);
      return {
        role: rec.scope === 'admin' ? 'admin' : 'readonly',
        totp: false,
        via: 'api_token',
        token: { id: rec.id, name: rec.name, scope: rec.scope, agentIds: rec.agent_ids }
      };
    }
    // 未命中静默落入后续分支（不额外报错，避免 Token 枚举信号）。
  }
  const at = req.header('X-Admin-Token');
  // P0：Token 只存哈希，校验改为「明文 → sha256 → 与库中哈希恒时比较」。
  if (at && verifyAdminToken(at)) return { role: 'admin', totp: false, via: 'token' };
  const rt = req.header('X-Readonly-Token');
  const roTok = process.env.READONLY_TOKEN;
  if (rt && roTok && safeEqual(rt, roTok)) return { role: 'readonly', totp: false, via: 'token' };
  return null;
}

// S2/F5：可选节点白名单中间件。挂在鉴权中间件之后、具体 handler 之前。
// agent_ids 为空数组 = 不限制；非空时由 handler 用 inAgentScope(req, id) 判定。
function agentScope(req, res, next) {
  const tok = req.auth && req.auth.token;
  if (tok && Array.isArray(tok.agentIds) && tok.agentIds.length > 0) {
    req.agentScope = new Set(tok.agentIds.map(String));
  }
  next();
}

function inAgentScope(req, id) {
  if (!req.agentScope) return true;
  return req.agentScope.has(String(id));
}

function adminAuth(req, res, next) {
  const r = resolveRole(req);
  if (!r || r.role !== 'admin') return res.status(401).json({ error: 'unauthorized' });
  if (!requireProto(req, res)) return;
  req.role = r.role;
  req.auth = r;
  next();
}

// 读接口：admin 或 readonly 均可访问（查看数据）。不强制 2FA，兼容 Grafana / 只读 Token / /metrics 拉取。
function adminOrReadonly(req, res, next) {
  const r = resolveRole(req);
  if (!r) return res.status(401).json({ error: 'unauthorized' });
  if (!requireProto(req, res)) return;
  req.role = r.role;
  req.auth = r;
  next();
}

// 写接口：仅 admin 可访问；若已启用 2FA，则要求 TOTP 已验证（cookie 内含 totp 标志）或本次提供 X-TOTP 头。
// 静态 Admin Token 单独调用写接口将被拒绝（need_totp），真正保护危险写操作。
function adminOnly(req, res, next) {
  const r = resolveRole(req);
  if (!r) return res.status(401).json({ error: 'unauthorized' });
  if (r.role !== 'admin') return res.status(403).json({ error: 'admin required' });
  if (db.is2FAEnabled()) {
    // 失败节流（L-2）：锁定期内直接 429，避免在线枚举 TOTP。
    if (!totpGuard(req)) {
      return res.status(429).json({ error: 'too many totp failures', need_totp: true });
    }
    const ok = r.totp || verifyTotpHeader(req);
    if (!ok) {
      recordTotpFailure(req);
      return res.status(401).json({ error: 'totp required', need_totp: true });
    }
  }
  if (!requireProto(req, res)) return;
  req.role = r.role;
  req.auth = r;
  next();
}

// 仅 admin（不强制 2FA），供 2FA 管理端点使用；这些端点自身会校验 TOTP code，避免被静态 Token 绕过。
function requireAdmin(req, res, next) {
  const r = resolveRole(req);
  if (!r) return res.status(401).json({ error: 'unauthorized' });
  if (r.role !== 'admin') return res.status(403).json({ error: 'admin required' });
  if (!requireProto(req, res)) return;
  req.role = r.role;
  req.auth = r;
  next();
}

// ── TOTP 重放防护 + 失败节流（体检 L-2）───────────────────────────────────────────
// 问题 1：verifyTOTP 只遍历 counter±1 比对，同一 6 位码在 ~90s 窗口内可被重放。
//         修复：记录「已消费的 (secret, counter)」，同一码只能用一次。
// 问题 2：X-TOTP 头路径无失败限流，凭据泄露时可在线枚举。修复：按 IP 计失败次数并锁定。
const USED_TOTP_MAX = 1000;          // 已消费表上限（超限整表清，防内存滥用）
const TOTP_FAIL_WINDOW = 10 * 60 * 1000; // 失败统计窗口 10 分钟
const TOTP_FAIL_MAX = 5;             // 窗口内允许的失败次数
const usedTotp = new Map();          // `${secretFp}:${counter}` -> 过期时刻(ms)
const totpFails = new Map();         // ip -> { n, reset }

// 只对 secret 取指纹入键，避免明文密钥驻留在 Map 键中。
function secretFingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8);
}

function pruneUsedTotp(now) {
  for (const [k, exp] of usedTotp) {
    if (exp <= now) usedTotp.delete(k);
  }
}

// 定期清理过期条目（unref 避免阻止进程退出）。
const usedTotpTimer = setInterval(() => pruneUsedTotp(Date.now()), 60 * 1000);
if (usedTotpTimer.unref) usedTotpTimer.unref();

/**
 * 校验 TOTP 且保证同一时间步只成功一次（防重放）。
 * @returns {boolean} 通过返回 true；码错误、已消费、已锁定均返回 false
 */
function verifyTotpOnce(secretBase32, code, opts = {}) {
  if (!secretBase32 || !code) return false;
  const hit = totp.matchCounter(secretBase32, code, opts);
  if (!hit) return false;
  const key = secretFingerprint(secretBase32) + ':' + hit.counter;
  if (usedTotp.has(key)) return false;          // 已消费 → 拒绝重放
  if (usedTotp.size >= USED_TOTP_MAX) usedTotp.clear(); // 上限保护
  // 该时间步的有效期：counter 窗口结束后再多保留一个周期，覆盖 ±1 窗口
  const expiresAt = (hit.counter + 2) * hit.period * 1000;
  usedTotp.set(key, expiresAt);
  return true;
}

/**
 * TOTP 失败节流：同一 IP 在 TOTP_FAIL_WINDOW 内失败达 TOTP_FAIL_MAX 次即锁定。
 * 进入时检查（返回 false 表示已锁定）；调用方在失败分支调 recordTotpFailure(req)。
 * @returns {boolean} true = 允许继续校验；false = 已锁定
 */
function totpGuard(req) {
  const ip = (req && req.ip) || '';
  const rec = totpFails.get(ip);
  if (!rec) return true;
  if (Date.now() > rec.reset) { totpFails.delete(ip); return true; }
  return rec.n < TOTP_FAIL_MAX;
}

function recordTotpFailure(req) {
  const ip = (req && req.ip) || '';
  const now = Date.now();
  const rec = totpFails.get(ip);
  if (!rec || now > rec.reset) {
    totpFails.set(ip, { n: 1, reset: now + TOTP_FAIL_WINDOW });
    return;
  }
  rec.n += 1;
}

function clearTotpFailures(req) {
  const ip = (req && req.ip) || '';
  totpFails.delete(ip);
}

function verifyTotpHeader(req) {
  const code = req.header('X-TOTP');
  const secret = db.get2FASecret();
  if (!code || !secret) return false;
  return verifyTotpOnce(secret, code);
}

// IP 白名单中间件。从 DB uiSettings.admin_allow_ips 读取，支持逗号分隔 IP/CIDR，空则全放行。
// 同时支持 IPv4 和 IPv6（含 IPv4-mapped IPv6 如 ::ffff:192.168.1.1）。
function ipWhitelist(req, res, next) {
  const raw = (db.getUiSettings().admin_allow_ips || '').trim();
  if (!raw) return next();
  const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (entries.length === 0) return next();
  const ip = normalizeIp(req.ip || req.socket.remoteAddress || '');
  if (!ip) return res.status(403).json({ error: 'ip not allowed' });
  // 精确匹配（同时比较原始形态与归一化形态）
  for (const entry of entries) {
    if (ip === normalizeIp(entry) || ip === entry) return next();
  }
  // CIDR 匹配
  for (const entry of entries) {
    if (entry.includes('/')) {
      if (ipInCIDR(ip, entry)) return next();
    }
  }
  return res.status(403).json({ error: 'ip not allowed' });
}

// 归一化 IP：剥除 IPv4-mapped IPv6 前缀（::ffff:），小写，便于比对。
function normalizeIp(ip) {
  if (!ip) return '';
  let s = String(ip).toLowerCase().trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}

// CIDR 匹配：自动识别 IPv4 / IPv6，调用对应实现。
function ipInCIDR(ip, cidrEntry) {
  const parts = cidrEntry.split('/');
  if (parts.length !== 2) return false;
  const range = parts[0].toLowerCase().trim();
  const bits = parseInt(parts[1], 10);
  if (isNaN(bits) || bits < 0) return false;
  if (range.includes(':')) {
    // IPv6 CIDR
    return ip6InCIDR(ip, range, bits);
  }
  // IPv4 CIDR
  return ip4InCIDR(ip, range, bits);
}

function ip4InCIDR(ip, cidr, bits) {
  const ipN = ip4ToInt(ip);
  const cidrN = ip4ToInt(cidr);
  if (ipN === null || cidrN === null || bits > 32) return false;
  const mask = bits === 0 ? 0 : ~(2 ** (32 - bits) - 1);
  return (ipN & mask) === (cidrN & mask);
}

function ip4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// IPv6 CIDR 匹配：将地址解析为 128 位 BigInt，按前缀长度比较。
function ip6InCIDR(ip, cidr, bits) {
  if (bits > 128) return false; // BUG 1 修复：防止 bits 过大导致 BigInt >> 负数抛 RangeError
  const ipBits = ip6ToBits(ip);
  const cidrBits = ip6ToBits(cidr);
  if (ipBits === null || cidrBits === null) return false;
  if (bits === 0) return true;
  if (bits === 128) return ipBits === cidrBits;
  const shift = 128n - BigInt(bits);
  return (ipBits >> shift) === (cidrBits >> shift);
}

// ---- 审计日志：记录管理员写操作 ----
// 操作者标识（与审计 admin 列同款格式）。F8.6 的恢复请求要把它写进请求文件，
// 由宿主脚本在恢复完成后回写审计 —— 否则「谁发起了恢复」会随旧库一起消失。
function actorLabel(req) {
  const sess = getSession(req);
  const r = resolveRole(req);
  const who = sess?.role === 'admin' ? 'admin(session)' : (r?.via === 'token' ? 'admin(token)' : 'unknown');
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return ip ? `${who} ${ip}` : who;
}

// 从 req 提取操作者身份和 IP 并落库。
function auditLog(req, action, detail) {
  try {
    const r = resolveRole(req);
    const via = r?.via || '';
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    db.addAuditLog(Date.now(), actorLabel(req), ip, action, detail, via);
  } catch { /* 审计失败不影响主流程 */ }
}

module.exports = {
  agentAuth, adminAuth, adminOrReadonly, adminOnly, requireAdmin, ipWhitelist, requireProto,
  resolveRole, agentScope, inAgentScope,
  safeEqual, signSession, verifySession, getSession, verifyAdminToken,
  setSessionCookie, clearSessionCookie, COOKIE_NAME, SESSION_TTL,
  revokeAllSessions, verifyTotpHeader, auditLog, actorLabel, clearSessionCache,
  verifyTotpOnce, totpGuard, recordTotpFailure, clearTotpFailures,
};
