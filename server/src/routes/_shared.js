'use strict';
// 路由域共用的中间件与纯函数（P2-1 拆分第一步：零行为变更）。
//
// 只放「原本定义在 api.js 内部、且被多个域引用」的东西：
//   - 应用层限流（全局 / 登录 / 初始化 / 自助注册）
//   - 登录暴力防护的 key 归一与审计
//   - agentGlobalOnly（受限 Token 禁止改全局配置）
//   - diffKeys（审计粒度）
//
// 依赖方向固定：_shared.js → auth / ratelimit，**不得反向 require 任何域文件**，
// 否则域之间会形成循环引用。已在独立模块里的中间件（adminOnly / agentScope /
// requireAdmin）直接从 ../auth 引，不要在这里复制一份。

const crypto = require('crypto');
const { rateLimitTouch, bucketKey } = require('../ratelimit');
const { auditLog } = require('../auth');

// ---- 应用层限流（兜底，不依赖 Nginx）：每 IP 每 10s 最多 60 次 ----
// /report 已由 Nginx 单独限流，此处放行。trust proxy 已在 server.js 启用，req.ip 为真实客户端。
// 放宽到 60 次：单标签页前端每 5s 约 4 请求(8/10s)，多标签页/多设备共享同一源 IP
// 时极易超过 20 次阈值而误伤正常浏览。应用层限流仅为兜底，真实安全边界仍由 Nginx limit_req。
// 审查 C3/C-3：计数逻辑统一走 src/ratelimit.js（惰性过期 + 淘汰最旧，无整表清空）。
const RATE_WINDOW = 10000, RATE_MAX = 60;
const rateHits = new Map();
const rateLimit = (req, res, next) => {
  if (req.path === '/report') return next();
  if (!rateLimitTouch(rateHits, bucketKey(req.ip || req.socket.remoteAddress), RATE_WINDOW, RATE_MAX)) {
    return res.status(429).json({ error: 'too many requests' });
  }
  next();
};

// 审计 diff 粒度（体检 L-4）：只记「改了哪些字段名」，不记值；敏感键打码为 k=*。
// 一律用 String 比较口径：'0' 与 0 视为相同（避免纯类型差异产生噪声告警）。
// 导出供测试直接断言（api.js 的 router 不便单测）。
const SENSITIVE_RE = /(token|secret|pass|key)/i;
function diffKeys(before, after) {
  const b = before || {};
  const a = after || {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return [...keys]
    .filter((k) => String(b[k] ?? '') !== String(a[k] ?? ''))
    .map((k) => (SENSITIVE_RE.test(k) ? `${k}=*` : k))
    .join(',');
}

// ---- 登录专项限流（M-5 修复）----
// 全局限流（20次/10s）对登录来说太宽松：攻击者仍可以 20 次/10s 的速度尝试 Token。
// 此处对 /api/login 单独收紧到每 IP 每 60s 最多 5 次，大幅降低暴力破解效率。
// Admin Token 为 256 位随机值，理论上不可暴力破解；此限流主要防日志刷屏与资源消耗。
const LOGIN_WINDOW = 60000, LOGIN_MAX = 5;
const loginHits = new Map();
const loginRateLimit = (req, res, next) => {
  if (!rateLimitTouch(loginHits, bucketKey(req.ip || req.socket.remoteAddress), LOGIN_WINDOW, LOGIN_MAX)) {
    return res.status(429).json({ error: 'too many login attempts, retry in 60s' });
  }
  next();
};

// ---- 登录暴力防护（F9）----
// 失败计数 + 指数封禁（count^4），详见 src/ratelimit.js 的 loginGuard。
// 维度说明：diting 登录是「Admin Token + TOTP」，不存在 username 概念，故以 IP 为主体；
// 将来若引入账号体系，把 key 改成 ip|username 即可，主逻辑不变。
// 已知取舍（见 CHANGELOG 与 docs/security.md）：管理员自己输错 3 次也会被封 81 秒，
// 需等 Retry-After 或重启服务（内存态）解除。
// S4：封禁维度同样按 /64 归桶——否则攻击者轮换接口 ID 即可绕开指数封禁。
const loginGuardKey = (req) => bucketKey(req.ip || req.socket?.remoteAddress || 'unknown');
// 审计只记 key 哈希，不落明文 IP（IP 属可关联信息，不进审计明文）。
const loginGuardKeyHash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
// 统一记录封禁并写审计（action=login_banned，detail 含 key 哈希与 Retry-After）。
const noteLoginBanned = (req, gkey, g) => {
  if (!g.banned) return;
  auditLog(req, 'login_banned', `key=${loginGuardKeyHash(gkey)} retry_after=${g.retryAfterSec}`);
};

// ---- 全局配置守卫 ----
// 受限 Token（agent_ids 非空）只被授权操作白名单节点，不得改动全局设置、告警分组阈值、
// 通知渠道、AI 配置、备份与 2FA —— 否则「只授权节点 A」的 Token 仍能关掉全站告警或改
// 系统设置，等于绕过了节点边界。
// 挂载顺序固定为 adminOnly/requireAdmin → agentScope → agentGlobalOnly。
const agentGlobalOnly = (req, res, next) =>
  (req.agentScope ? res.status(403).json({ error: 'forbidden_scope' }) : next());

// ---- 初始化端点限流（纵深防御）----
// 每 IP 每 60s 最多 5 次，防止未授权时暴力/竞态抢占。
const SETUP_WINDOW = 60000, SETUP_MAX = 5;
const setupHits = new Map();
const setupRateLimit = (req, res, next) => {
  if (!rateLimitTouch(setupHits, bucketKey(req.ip || req.socket.remoteAddress), SETUP_WINDOW, SETUP_MAX)) {
    return res.status(429).json({ error: 'too many requests' });
  }
  next();
};

// ---- 自助注册限流 ----
// 注册端点专用：独立桶，避免与初始化/登录的额度互相挤占。
const REGISTER_WINDOW = 60000, REGISTER_MAX = 10;
const registerHits = new Map();
const registerRateLimit = (req, res, next) => {
  if (!rateLimitTouch(registerHits, bucketKey(req.ip || req.socket.remoteAddress), REGISTER_WINDOW, REGISTER_MAX)) {
    return res.status(429).json({ error: 'too many requests' });
  }
  next();
};

module.exports = {
  rateLimit,
  loginRateLimit,
  loginGuardKey,
  loginGuardKeyHash,
  noteLoginBanned,
  agentGlobalOnly,
  setupRateLimit,
  registerRateLimit,
  diffKeys,
};
