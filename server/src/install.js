'use strict';
// 安装向导（复刻 komari web/install/install.go 的机制，适配 diting 的单管理员 Token 模型）。
//
// 与 komari 的对应关系：
//   komari：users 表为空 = 未安装（唯一判据，无安装标志位），启动独立 guide server，
//           其他 API 一律 404、页面 GET 一律 307 → /install；
//   diting：库中无 admin_token_hash = 未安装（同样唯一判据，不引入标志位），
//           同一 Express 实例内由 server.js 的 installGate 收敛管理面 + 页面 307；
//           agent 上报面（/api/v1/*、/api/report 等）与 SETUP_TOKEN 自助注册不受影响。
//
// 三层防重复安装（对应 komari：内存状态机 → users 计数 → 完成后路由消失）：
//   1. 内存状态机 state（ready → completed），非 ready 一律 409 Conflict；
//   2. 已存在 Token 哈希（hasAdminToken）→ 410 Gone；
//   3. 原子抢写 setAdminTokenHashIfAbsent（INSERT OR IGNORE，防多实例竞态）→ 抢不到 410。
//   "哈希存在"本身就是初始化锁，不再需要 admin_initialized 标志位（P0 已清理该键）。
//   站点信息写失败 → 回滚哈希，向导保持可重试（对应 komari 安装失败回滚账户的语义）。
//
// 凭据口径（P0 起）：库中**只存 sha256 哈希**，明文仅在 generate 模式的响应里一次性回显；
// 不写 .env、不改进程 env —— 旧实现两个都做，而容器内 /app/.env 不持久，重启即丢 Token。

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { rateLimitTouch } = require('./ratelimit');
const { hasAdminToken, hashAdminToken, MIN_LEN, PLACEHOLDER } = require('./token-policy');
const { requireProto, safeEqual } = require('./auth');
const { resolveSetupToken } = require('./setup-token');

const router = express.Router();

// ---- 内存状态机（对应 komari Controller.state 的 ready/completing/completed）----
let state = 'ready';
function getState() { return state; }

// 「是否需要安装」的唯一判据：库中没有合法的 Token 哈希。
// 与 /api/setup/status 的 needs_setup、server.js 的启动日志共用同一口径。
function needsInstall() { return !hasAdminToken(); }

// 初始化端点限流（与 /api/setup/generate 同口径）：每 IP 每 60s 最多 5 次。
const WINDOW = 60000, MAX = 5;
const hits = new Map();
const installRateLimit = (req, res, next) => {
  if (!rateLimitTouch(hits, req.ip || req.socket.remoteAddress, WINDOW, MAX)) {
    return res.status(429).json({ error: 'too many requests' });
  }
  next();
};

// 内网监听端口：只读展示用（端口属于宿主侧，容器按创建时的 ports: 发布，
// 换端口必须改 .env 的 PORT 并重建容器，见 T1.5/T1.6；向导不提供修改入口）。
function listenPort() {
  const n = Number(process.env.PORT);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 8081;
}

// GET /api/install/status：前端向导探测。required=false 时前端显示「已初始化」锁定视图。
router.get('/status', (req, res) => {
  // install_token_required：远程来源完成安装时是否需要口令（前端据此决定
  // 是否渲染口令输入框）。注意这是"来源判定"，不是"是否已配置口令"——
  // 口令未配置时远程来源同样需要（然后会拿到 install_token_required 提示）。
  res.json({
    state: getState(),
    required: needsInstall(),
    port: listenPort(),
    install_token_required: !isTrustedInstallSource(req),
  });
});

// ---- 地址归一化 ----
// 只接受 http(s)、无 userinfo、≤200 字符；去掉 query/hash 与尾斜杠
// （getPublicBaseUrl 拼安装命令时会再 replace(/\/+$/,'')，这里提前收敛避免双斜杠）。
const URL_MAX = 200;
function normalizeBaseUrl(raw, { required }) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return required ? { error: 'required' } : { value: '' };
  if (s.length > URL_MAX) return { error: 'too_long' };
  let u;
  try { u = new URL(s); } catch { return { error: 'invalid' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'scheme' };
  if (u.username || u.password) return { error: 'userinfo' };
  if (!u.hostname) return { error: 'invalid' };
  const p = u.pathname.replace(/\/+$/, '');
  return { value: `${u.protocol}//${u.host}${p === '/' ? '' : p}` };
}

// 软告警（不阻断）：受控端可能连不上回环/内网地址；显式端口与监听端口不一致时
// 提示反代 upstream 需对齐。都是"提示不拦截"，因为反代端口与监听端口本来就常不同。
const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|::1|\[::1\])$/i;
function urlWarnings(url) {
  const warnings = [];
  if (!url) return warnings;
  let u;
  try { u = new URL(url); } catch { return warnings; }
  if (PRIVATE_HOST_RE.test(u.hostname)) warnings.push('agent_server_url_private');
  if (u.port && Number(u.port) !== listenPort()) warnings.push('agent_server_url_port_mismatch');
  return warnings;
}

// ---- 安装期访问口径（§6.7 / G6：规则必须显式）---------------------------------
// 未安装实例的 `complete` 会**设定管理员 Token**，等于把实例交给调用者。因此不能
// 只靠"来源是内网"就放行——同网段任何主机、或 Docker 网桥内的其它容器都能连到
// 8081。显式规则：
//   hasProxyHeader = 带 X-Forwarded-For / X-Real-IP / Forwarded
//   isPrivate      = remoteAddress ∈ 127/8、::1、RFC1918、ULA（含 Docker 网桥）
//   可信来源       = isPrivate && !hasProxyHeader   // 本机直连 / SSH 隧道
//   其余一律视为远程 ⇒ 必须提供 install_token（= SETUP_TOKEN，安装器打印的那个）
// 反向可证：经 Nginx 反代的请求一定带 X-Forwarded-For/X-Real-IP，即使反代在本机
// 也不会被误判为可信——那正是"内网页面被外人打开"的真实场景。
function hasProxyHeader(req) {
  const h = req.headers || {};
  return !!(h['x-forwarded-for'] || h['x-real-ip'] || h['forwarded']);
}
function isPrivateSource(req) {
  const addr = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (!addr) return false;
  if (addr === '::1' || /^127\./.test(addr)) return true;
  if (/^10\./.test(addr) || /^192\.168\./.test(addr)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true;   // fc00::/7 ULA
  return false;
}
const isTrustedInstallSource = (req) => isPrivateSource(req) && !hasProxyHeader(req);

// ---- 请求校验（对应 komari completeRequest：sitename 1~100、description ≤1000）----
function validateInstall(body) {
  const b = body || {};
  const sitename = String(b.sitename || '').trim();
  const description = String(b.description || '').trim();
  const mode = b.token_mode === 'custom' ? 'custom' : 'generate';
  if (!sitename || sitename.length > 100) {
    return { error: 'invalid_sitename', message: '站点名称必须为 1~100 个字符' };
  }
  if (description.length > 1000) {
    return { error: 'invalid_description', message: '站点描述不能超过 1000 个字符' };
  }
  // 站点网址可选；上报地址必填 —— 受控端安装命令由 getPublicBaseUrl() 生成，
  // 优先级 agent_server_url > site_url > PUBLIC_URL，未配置直接 400 server_url_not_configured。
  const siteUrl = normalizeBaseUrl(b.site_url, { required: false });
  if (siteUrl.error) {
    return { error: 'invalid_site_url', message: '站点网址格式不正确（需以 http:// 或 https:// 开头，且不超过 200 字符）' };
  }
  const agentUrl = normalizeBaseUrl(b.agent_server_url, { required: true });
  if (agentUrl.error) {
    if (agentUrl.error === 'required') {
      return { error: 'missing_agent_server_url', message: '上报地址必填：受控端安装命令依赖该地址生成' };
    }
    return { error: 'invalid_agent_server_url', message: '上报地址格式不正确（需以 http:// 或 https:// 开头，且不超过 200 字符）' };
  }
  let token = '';
  if (mode === 'custom') {
    token = String(b.token || '').trim();
    // diting 口径（token-policy）：≥16 位且非占位符。占位符提示给出具体原因。
    if (!token) {
      return { error: 'weak_token', message: '自定义 Token 不能为空' };
    }
    if (token === PLACEHOLDER) {
      return { error: 'weak_token', message: '自定义 Token 不能使用示例占位符' };
    }
    if (token.length < MIN_LEN) {
      return { error: 'weak_token', message: `自定义 Token 至少 ${MIN_LEN} 个字符` };
    }
    // 复刻 komari 密码强度检查的精神（挡"够长但可猜"的值），口径对齐
    // /api/setup/register 的 isWeakSetupToken：纯数字、字符种类过少、连续序列一律拒绝。
    if (/^\d+$/.test(token) || new Set(token).size <= 4) {
      return { error: 'weak_token', message: '自定义 Token 强度不足（纯数字或字符种类过少），建议使用 openssl rand -hex 32 生成' };
    }
    if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf)/i.test(token)) {
      return { error: 'weak_token', message: '自定义 Token 含连续序列（如 1234/abcd），强度不足' };
    }
  }
  return {
    sitename, description, mode, token,
    siteUrl: siteUrl.value,
    agentServerUrl: agentUrl.value,
    warnings: urlWarnings(agentUrl.value),
  };
}

// POST /api/install/complete：单步提交站点信息 + 管理员凭据（对应 komari complete）。
// 注意：requireProto 是「返回 boolean 的辅助函数」而非 Express 中间件（auth.js 内部
// 均以 if (!requireProto(req, res)) return; 调用），直接挂载会导致请求永久挂起。
router.post('/complete', installRateLimit, (req, res) => {
  // 管理类凭证与 /api/setup/generate 同口径：必须经 HTTPS 反代；
  // 例外是 SSH 隧道直连回环（requireProto 内部判定，见 auth.js）。
  if (!requireProto(req, res)) return;
  // 抢占防护（§6.7 / G6）：远程来源必须带 install_token（= SETUP_TOKEN）。
  // 判据只看"私网 + 零代理头"，不看 Token 本身强弱——口令由安装器生成，
  // 即使被设成弱值也只是一次性安装门槛，不影响后续 SETUP_TOKEN 的注册强度校验。
  if (!isTrustedInstallSource(req)) {
    const { token } = resolveSetupToken();
    const provided = String((req.body && req.body.install_token) || req.header('X-Install-Token') || '').trim();
    if (!token) {
      return res.status(403).json({
        error: 'install_token_required',
        message: '远程访问安装向导需提供安装口令：服务端未配置 SETUP_TOKEN，请在服务器上执行 sudo bash diting.sh --install-server 生成，或通过 ssh -L 隧道从本机访问',
      });
    }
    if (!provided || !safeEqual(provided, token)) {
      return res.status(403).json({ error: 'invalid_install_token', message: '安装口令不正确（install_token 应为安装结束时打印的 SETUP_TOKEN）' });
    }
  }
  // 三层防重装之 ①：内存状态机。completed 状态一律 409。
  if (state !== 'ready') {
    return res.status(409).json({ error: 'already_completed', message: '安装已完成或正在进行中' });
  }
  // 三层防重装之 ②：库中已有 Token 哈希（另一个实例先装完，或外部已配置）。
  if (hasAdminToken()) {
    state = 'completed';
    return res.status(410).json({
      error: 'already_initialized',
      message: '管理员 Token 已存在，安装向导已禁用。重置 Token 请通过 SSH 运行：sudo bash diting.sh --reset-admin-token'
    });
  }
  const v = validateInstall(req.body || {});
  if (v.error) {
    return res.status(400).json({ error: v.error, message: v.message });
  }
  const token = v.mode === 'custom' ? v.token : 'adm_' + crypto.randomBytes(16).toString('hex');
  // 三层防重装之 ③：原子抢写哈希（INSERT OR IGNORE）。多实例并发时只有一个成功，
  // 抢不到即视为"已安装"——哈希存在性本身就是锁，无需额外 admin_initialized 标志位。
  if (!db.setAdminTokenHashIfAbsent(hashAdminToken(token))) {
    state = 'completed';
    return res.status(410).json({
      error: 'already_initialized',
      message: '另一实例已完成初始化（Token 哈希已写入）。重置 Token 请通过 SSH 运行：sudo bash diting.sh --reset-admin-token'
    });
  }
  // 站点信息并入 ui_settings（setUiSettings 是整体覆盖，必须在调用方 merge，
  // 否则会抹掉主题/CSS/告警阈值等既有键）。写失败回滚哈希，向导保持可重试。
  try {
    const ui = db.getUiSettings();
    db.setUiSettings(Object.assign({}, ui, {
      site_title: v.sitename,
      site_description: v.description,
      site_url: v.siteUrl,
      agent_server_url: v.agentServerUrl,
    }));
  } catch (e) {
    db.clearAdminTokenHash();
    console.error('[install] 写入站点信息失败:', e.message);
    return res.status(500).json({ error: 'write_failed', message: '保存站点信息失败，请检查数据库磁盘空间与可写性' });
  }
  state = 'completed';
  console.log('[install] 安装完成：Token 哈希已入库，站点信息已保存；/api/install/* 自此禁用');
  // generate 模式回显一次性明文；custom 模式不回显（管理员自己填的）
  res.json({ status: 'success', token: v.mode === 'generate' ? token : '', warnings: v.warnings });
});

module.exports = { router, needsInstall, getState, listenPort };
