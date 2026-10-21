require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const db = require('./src/db');
const api = require('./src/api');
const compat = require('./src/compat');
const { handleRpc } = require('./src/compat-rpc');
const v1 = require('./src/v1');
const alerts = require('./src/alerts');
const ai = require('./src/ai');
const { safeEqual, ipWhitelist, resolveRole } = require('./src/auth');
const { rateLimitTouch } = require('./src/ratelimit');
const { sanitizeCss } = require('./src/validate');
const { getAdminToken, tokenIssue, MIN_LEN } = require('./src/token-policy');
// Node ≥15 起，未捕获的 promise rejection 默认会杀掉进程（--unhandled-rejections=throw）。
// 这里降级为「记录 + 存活」，避免单个请求异常导致整个监控站不可用。
// 真正的修复是把 async 路由套 asyncHandler（见 src/util.js）；此处只是最后兜底。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e && e.stack ? e.stack : e);
});

// 读取版本号与构建时间（diting.sh 部署时写入 _build_time，版本来自 package.json）
const APP_VERSION = (() => {
  try { return require('./package.json').version || '1.0.0'; } catch (e) { return '1.0.0'; }
})();
const APP_BUILD_TIME = (() => {
  try {
    const pkg = require('./package.json');
    if (pkg._build_time && pkg._build_time !== 'BUILD_TIME_PLACEHOLDER') return pkg._build_time;
  } catch (e) {}
  // 回退：读取构建时间文件（diting.sh 生成）
  try { return fs.readFileSync(path.join(__dirname, 'build_time.txt'), 'utf-8').trim(); } catch (e) {}
  return 'unknown';
})();
// 构建 commit 短 hash：env GIT_HASH → package.json._git_hash → git_hash.txt（diting.sh 生成）
// → 本机直接 git rev-parse（非 git 环境静默降级为 '-'）
const APP_HASH = (() => {
  if (process.env.GIT_HASH) return process.env.GIT_HASH;
  try {
    const pkg = require('./package.json');
    if (pkg._git_hash) return pkg._git_hash;
  } catch (e) {}
  try { return fs.readFileSync(path.join(__dirname, 'git_hash.txt'), 'utf-8').trim(); } catch (e) {}
  try {
    return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
  } catch (e) {}
  return '-';
})();

const app = express();
// 信任前置反代（Nginx）的 X-Forwarded-*，使 req.ip 取到真实客户端 IP，
// 供应用层限流按客户端区分（而非全部归到 127.0.0.1）。Nginx 已设置 X-Forwarded-For。
//
// H-02 收紧：此前为 trust proxy = true（信任任意来源的 X-Forwarded-*）。
// 一旦 :8081 被直连（如 docker 把端口映射到 0.0.0.0），攻击者可自造
// `X-Forwarded-For: <白名单内 IP>` 绕过 admin_allow_ips、按 IP 限流与审计来源，
// 或自造 `X-Forwarded-Proto: https` 让 requireProto 放行明文管理请求。
// 现默认只信任 loopback（本机 Nginx 反代，即推荐部署形态）；
// 反代在其他主机/容器时，用 TRUST_PROXY 显式声明可信代理，例如：
//   TRUST_PROXY=127.0.0.1            —— 单个代理地址
//   TRUST_PROXY=172.16.0.0/12,10.0.0.8 —— 逗号分隔的 CIDR/IP（docker 网络常见）
//   TRUST_PROXY=1                    —— 信任 1 跳（代理链固定时可用）
// 详见 README「反向代理与 TRUST_PROXY」。
//
// ⚠️ 为什么默认值要做成函数而不是字符串 'loopback'：
// Express 的 'loopback' 关键字只匹配 127.0.0.0/8 与 ::1/128。而 Node 的 listen(port)
// 默认绑 ::（IPv6 双栈），内核把 IPv4 回环对端表示为 IPv4-mapped 的 ::ffff:127.0.0.1，
// 它既不等于 ::1 也匹配不到 127.0.0.0/8 —— 于是本机反代会被判为"非可信来源"，
// 请求里的 X-Forwarded-For 被完整采信，等同于把 H-02 的绕过原样保留：
//   实测 `curl -H 'X-Forwarded-For: 203.0.113.9' http://localhost:8081/api/agents`
//   在白名单只允许 203.0.113.9 时返回 200（应为 403）。
// 故这里按请求对端地址自行判定回环（含 ::ffff: 映射形态），语义等同 loopback 但更可靠。
// 判定只看 socket 对端，与请求头无关，无法被伪造。
const LOOPBACK_RE = /^(::1|127(\.\d{1,3}){3}|::ffff:(127(\.\d{1,3}){3}|::1))$/;
const proxyLoopback = (addr) => LOOPBACK_RE.test(String(addr || '').toLowerCase().trim());
const TRUST_PROXY_RAW = String(process.env.TRUST_PROXY || 'loopback').trim() || 'loopback';
const TRUST_PROXY = /^\d+$/.test(TRUST_PROXY_RAW)
  ? Number(TRUST_PROXY_RAW)                                  // 跳数
  : TRUST_PROXY_RAW.split(',').map((s) => s.trim()).filter(Boolean); // 地址/CIDR 列表
const TRUST_PROXY_RESOLVED = TRUST_PROXY_RESHAPE(TRUST_PROXY, TRUST_PROXY_RAW);
function TRUST_PROXY_RESHAPE(value, raw) {
  // 默认值（loopback）走自定义判定函数；用户显式配置的值原样交给 Express
  if (raw.toLowerCase() === 'loopback') return proxyLoopback;
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}
app.set('trust proxy', TRUST_PROXY_RESOLVED);

// 安全响应头：所有资源仅限同源，脚本仅限同源，禁止内联脚本。
// style-src 加 'unsafe-inline'：允许 inline style（进度条宽度/动态颜色等）。
// script-src 保持 'self'（无 unsafe-inline），阻断 XSS 注入外部脚本的主要路径。
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'"
  );
  // L-1 修复：补充安全响应头，纵深防御 XSS / 点击劫持 / MIME 嗅探
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0'); // 现代浏览器已弃用，CSP 是主力；设为 0 避免 IE 的过滤漏洞
  next();
});

// 启动期安全校验：Admin Token 过弱等于把后台钥匙留在门上。
// 判定口径见 src/token-policy（示例占位符 / 短于 16 位一律视为不可用，等同未设置）。
// 未设置或不可用时，首次访问走 Web 初始化向导；向导生成的 Token 会写入 .env（600）。
const ADMIN_TOKEN_ISSUE = tokenIssue(process.env.ADMIN_TOKEN);
if (!ADMIN_TOKEN_ISSUE) {
  console.log('[info] ADMIN_TOKEN 已从 .env 读取');
} else if (ADMIN_TOKEN_ISSUE === 'missing') {
  console.warn('[warn] 未设置 ADMIN_TOKEN：首次访问将走 Web 初始化向导生成。');
} else if (ADMIN_TOKEN_ISSUE === 'placeholder') {
  console.warn('[warn] ADMIN_TOKEN 仍是示例占位符 change-me-admin-token，已被忽略；首次访问将走 Web 初始化向导。请改为随机强值（openssl rand -hex 32）。');
} else {
  console.warn(`[warn] ADMIN_TOKEN 长度不足 ${MIN_LEN} 位（当前 ${String(process.env.ADMIN_TOKEN).length} 位），已被忽略；首次访问将走 Web 初始化向导。请改为随机强值（openssl rand -hex 32）。`);
}

// READONLY_TOKEN（可选）：鉴权侧目前接受任意非空值（auth.js 只做恒定时间比较），
// 因此过短/占位符仍会生效。此处只告警、不阻断，避免存量部署升级后突然失去只读访问；
// 但它能读取全部节点指标与备份列表，弱值等于公开数据，必须提示轮换。
const READONLY_TOKEN_ISSUE = tokenIssue(process.env.READONLY_TOKEN);
if (READONLY_TOKEN_ISSUE === 'placeholder') {
  console.warn('[warn] READONLY_TOKEN 仍是示例占位符 change-me-admin-token：虽会生效，但等于公开只读数据，请改为随机强值（openssl rand -hex 32）。');
} else if (READONLY_TOKEN_ISSUE === 'too_short') {
  console.warn(`[warn] READONLY_TOKEN 强度不足（仅 ${String(process.env.READONLY_TOKEN).length} 位）：虽会生效，但存在被枚举风险，建议改为随机强值（openssl rand -hex 32）。`);
}

// 启动期安全校验（审查 G1/G2）：
//   G2 — ADMIN_ALLOW_HTTP=1 会放行非 HTTPS 管理请求并去掉会话 Cookie 的 Secure 标志
//        （见 src/auth.js requireProto / setSessionCookie），仅限本地开发临时使用。
//   G1 — .env 含 ADMIN_TOKEN/SESSION_SECRET 等密钥，权限不应为 group/other 可读。
// 两处均为显式告警（不阻断启动）：本地开发可无视，生产环境看到应立即处置。
if (process.env.ADMIN_ALLOW_HTTP === '1') {
  console.warn('[warn] ADMIN_ALLOW_HTTP=1 已生效：非 HTTPS 管理请求将被放行，会话 Cookie 不带 Secure 标志。请确认这是本地开发环境；生产环境务必删除 .env 中的该行。');
}
try {
  const envPath = path.join(__dirname, '.env');
  const st = fs.statSync(envPath);
  if (st.mode & 0o077) {
    console.warn(`[warn] .env 权限过松（${(st.mode & 0o777).toString(8)}）：含 ADMIN_TOKEN/SESSION_SECRET 等密钥，同机其他用户可读。请执行 chmod 600 .env`);
  }
} catch { /* .env 不存在（纯环境变量部署）时跳过 */ }

app.use(express.json({ limit: '16kb' }));

// ---- Prometheus /metrics 导出（P3：可观测性）----
// 通过 Bearer Token 鉴权（仅 ADMIN_TOKEN，恒定时间比较）。默认强制 HTTPS
// （M-2：见下方 app.get('/metrics') 的 proto 校验；ADMIN_ALLOW_HTTP=1 可放行明文），
// 并受 IP 白名单约束。例：curl -H "Authorization: Bearer $ADMIN_TOKEN" https://host:8081/metrics
function promEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
const METRIC_DEFS = [
  { name: 'monitor_agent_cpu_percent',       desc: 'CPU 使用率（百分比）',           get: m => m && m.cpu },
  { name: 'monitor_agent_mem_used_bytes',    desc: '内存已用（字节）',               get: m => m && m.mem_used },
  { name: 'monitor_agent_mem_total_bytes',   desc: '内存总量（字节）',               get: m => m && m.mem_total },
  { name: 'monitor_agent_mem_percent',       desc: '内存使用率（百分比）',           get: m => m && m.mem_pct },
  { name: 'monitor_agent_disk_used_bytes',   desc: '磁盘已用（字节）',               get: m => m && m.disk_used },
  { name: 'monitor_agent_disk_total_bytes',  desc: '磁盘总量（字节）',               get: m => m && m.disk_total },
  { name: 'monitor_agent_disk_percent',      desc: '磁盘使用率（百分比）',           get: m => m && m.disk_pct },
  { name: 'monitor_agent_load1',             desc: '系统负载 1 分钟',                get: m => m && m.load1 },
  { name: 'monitor_agent_load5',             desc: '系统负载 5 分钟',                get: m => m && m.load5 },
  { name: 'monitor_agent_load15',            desc: '系统负载 15 分钟',               get: m => m && m.load15 },
  { name: 'monitor_agent_net_rx_rate_bytes', desc: '网络接收速率（字节/秒）',         get: m => m && m.net_rx_rate },
  { name: 'monitor_agent_net_tx_rate_bytes', desc: '网络发送速率（字节/秒）',         get: m => m && m.net_tx_rate },
  { name: 'monitor_agent_net_rx_total_bytes',desc: '当月累计接收（字节）',            get: m => m && m.net_rx_month },
  { name: 'monitor_agent_net_tx_total_bytes',desc: '当月累计发送（字节）',            get: m => m && m.net_tx_month },
  { name: 'monitor_agent_uptime_seconds',    desc: '系统运行时长（秒）',             get: m => m && m.uptime },
  { name: 'monitor_agent_last_seen_seconds', desc: '最近一次上报的 Unix 时间戳（秒）', get: m => m ? Math.floor((m.ts || 0) / 1000) : null },
];
app.get('/metrics', (req, res) => {
  // M-4 修复：/metrics 同样受 IP 白名单约束（与 /api 管理端一致），防 Token 泄露后从任意 IP 拉取数据。
  // ipWhitelist 内部空则全放行，未配置白名单时行为不变。
  ipWhitelist(req, res, () => {
    // M-2：默认强制 HTTPS，避免 ADMIN_TOKEN 在内网明文抓取时被嗅探。
    // 本地直连 http 调试可设 ADMIN_ALLOW_HTTP=1（与后台管理端同款开关）。
    const proto = String(req.header('X-Forwarded-Proto') || '').toLowerCase().split(',')[0].trim();
    const isHttps = proto === 'https' || req.secure;
    if (!isHttps && process.env.ADMIN_ALLOW_HTTP !== '1') {
      return res.status(403).set('Content-Type', 'text/plain').send('403 HTTPS required');
    }
    _metricsHandler(req, res);
  });
});
function _metricsHandler(req, res) {
  // 与后台管理接口同一口径：占位符 / <16 位视为不可用，不能只在这里接受原始 env，
  // 否则弱 ADMIN_TOKEN 仍可凭 /metrics 枚举数据（后台却已拒绝）。
  const adminToken = getAdminToken();
  if (!adminToken) {
    return res.status(401).set('Content-Type', 'text/plain').send('401 ADMIN_TOKEN not configured');
  }
  const auth = req.header('Authorization') || '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!t || !safeEqual(t, adminToken)) {
    return res.status(401).set('Content-Type', 'text/plain').send('401 Unauthorized');
  }
  const agents = db.getAgents();
  const now = Date.now();
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const lines = [];
  lines.push('# HELP monitor_up Agent 是否在线（最近上报在阈值内为 1）');
  lines.push('# TYPE monitor_up gauge');
  for (const a of agents) {
    const up = (now - (a.last_seen || 0)) <= offlineSec * 1000 ? 1 : 0;
    lines.push(`monitor_up{agent="${promEscape(a.id)}",name="${promEscape(a.name)}"} ${up}`);
  }
  for (const def of METRIC_DEFS) {
    lines.push(`# HELP ${def.name} ${def.desc}`);
    lines.push(`# TYPE ${def.name} gauge`);
    for (const a of agents) {
      const m = db.getLatestMetric(a.id);
      const v = def.get(m);
      if (v === null || v === undefined) continue;
      lines.push(`${def.name}{agent="${promEscape(a.id)}",name="${promEscape(a.name)}"} ${v}`);
    }
  }
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n');
}

// IP 白名单：保护管理 API（公开只读接口除外）
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/public/') || req.path === '/report' ||
      req.path.startsWith('/v1/') ||
      // /client-ip 是白名单排障入口：白名单配错时管理员需要它才能看清自己被识别成哪个 IP
      // （自身带 adminOrReadonly 鉴权，放行不会引入未授权访问）
      req.path === '/client-ip' ||
      req.path === '/me' || req.path === '/nodes' || req.path === '/recent' ||
      req.path === '/records/load' || req.path === '/records/ping' ||
      req.path === '/version' || req.path === '/rpc2' || req.path === '/clients/sse') return next();
  ipWhitelist(req, res, next);
});
// 版本信息端点。审查 G5：精确版本 + 构建时间可被用于匹配 CVE，匿名请求只回
// 主版本号（前端页脚降级显示）；携带有效管理员/只读凭据才回完整信息。响应同时
// 带第三方主题兼容协议的信封字段（status/message/data），与 compat 层形状一致。
// 注意：必须注册在 compat.router 之前——此前本路由被 compat 的 /version 静默
// 遮蔽成为死代码（那条只回静态占位符，从不泄露真实版本，但也从未生效）。
app.get('/api/version', (req, res) => {
  const role = resolveRole(req);
  // 2026-10-21 用户指定：页脚公开显示「版本 (commit)」与构建时间，
  // 匿名也返回完整版本号/hash（原先仅主版本号的 G5 收敛被显式放开）。
  const payload = { version: APP_VERSION, build_time: APP_BUILD_TIME, hash: APP_HASH };
  return res.json({
    status: 'success',
    message: '',
    data: Object.assign({ hash: '-' }, payload),
    ...payload,
  });
});
app.use('/api', api);
// 标准公开只读 API 层（/api/v1/*）：语义清晰、与皮肤协议解耦，供独立 adapter 翻译
app.use('/api/v1', v1.router);
// 第三方主题兼容 API 层：让社区皮肤可指向本服务（只读、脱敏，受 public_enabled 约束）
app.use('/api', compat.router);

// 公开状态页（首页 /）：支持第三方主题皮肤
// 若 ui_settings.public_theme 指向 public/themes/<id> 下的皮肤，则投放该皮肤首页；
// 否则回退到内置默认 public/index.html。主题目录名经白名单校验，杜绝路径穿越。
//
// 部分社区皮肤需要比 diting 默认更宽松的 CSP（内联脚本、Iconify/IP 地理定位等外部源）。
// 为守住「admin/API 页保持严格、仅首页主题页放宽」的边界，这里按请求生成一次性 nonce，
// 注入到主题的 inline <script>，并仅对本次响应覆盖 CSP 头。子资源（JS/CSS/图片）沿用文档策略，
// 无需单独设头。nonce 每次请求随机生成，不可复用，不可预测。
function themeRelaxedCsp(nonce) {
  return `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.iconify.design https://api.simplesvg.com https://api.unisvg.com https://ipwho.is https://ipapi.co https://api.ip.sb; font-src 'self' data:`;
}
// 把 nonce 注入主题的每一个 inline <script>（没有 src 的那些），外部模块脚本不受影响。
function injectNonce(html, nonce) {
  return html.replace(/<script(?![^>]*\bsrc=)/g, `<script nonce="${nonce}"`);
}
const THEMES_DIR = path.join(__dirname, 'public', 'themes');
const THEME_MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf'
};
// 需要 nonce 注入才能正常运行的社区主题白名单（CSP 仅对这些主题放宽）
const THEME_NEEDS_NONCE = new Set(['glassmorphism']);

// 审查 C5：静态资源流统一投放。此前三处裸 `fs.createReadStream(fp).pipe(res)`：
// 流错误（文件竞态删除 / 权限不足 / 读中途失败）会成为未捕获异常，客户端拿到
// 无响应（请求挂起到超时）。这里统一挂 error 处理——未发头则 500，已发头则断连。
function serveFileStream(res, fp) {
  const stream = fs.createReadStream(fp);
  stream.on('error', (err) => {
    console.error(`[static] stream error: ${fp} - ${err.message}`);
    try {
      if (res.headersSent) res.destroy();
      else res.status(500).end();
    } catch (_) { /* 响应已销毁时忽略 */ }
  });
  return stream.pipe(res);
}

// 第三方皮肤资源：用显式路由投放，不依赖 express.static 对 themes 目录的覆盖，
// 规避前置 Nginx / Docker 部署时静态目录未被代理 / 未打进镜像导致的 404。
// 主题目录名与路径均经白名单校验，杜绝路径穿越；按官方文档 /themes/{short}/... 映射主题包根目录。
// 注意：Express 4.22 的 ':id/*path' 星号通配不匹配多级路径，故用正则路由
// 精确捕获 id 与剩余子路径，支持社区主题的 SPA history 深链（如 /instance/<uuid>）。
app.get(/^\/themes\/([A-Za-z0-9_-]+)\/(.*)$/, (req, res, next) => {
  const id = req.params[0];
  const subPath = req.params[1] || '';
  const baseDir = path.join(THEMES_DIR, id);
  const fp = path.join(baseDir, subPath);
  if (!fp.startsWith(baseDir + path.sep)) return res.status(404).end();
  // 真实静态资源（带后缀）：存在则返回，否则 404 交给后续处理链。
  if (path.extname(req.path)) {
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return next();
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    const ext = path.extname(fp).toLowerCase();
    res.setHeader('Content-Type', THEME_MIME[ext] || 'application/octet-stream');
    return serveFileStream(res, fp);
  }
  // 无后缀深链（如 /themes/<id>/instance/<uuid>）：社区主题 SPA history 路由，
  // 回退到主题根 index.html，避免「Cannot GET」；nonce 注入对白名单主题放宽 CSP。
  const indexPath = path.join(baseDir, 'index.html');
  if (!fs.existsSync(indexPath)) return next();
  if (THEME_NEEDS_NONCE.has(id)) {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', themeRelaxedCsp(nonce));
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    return res.send(injectNonce(fs.readFileSync(indexPath, 'utf8'), nonce));
  }
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  return res.sendFile(indexPath);
});

// 裸主题根路径（如 /themes/glassmorphism）：返回主题 index.html。
app.get(/^\/themes\/([A-Za-z0-9_-]+)\/?$/, (req, res, next) => {
  const id = req.params[0];
  const baseDir = path.join(THEMES_DIR, id);
  const indexPath = path.join(baseDir, 'index.html');
  if (!fs.existsSync(indexPath)) return next();
  if (THEME_NEEDS_NONCE.has(id)) {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', themeRelaxedCsp(nonce));
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    return res.send(injectNonce(fs.readFileSync(indexPath, 'utf8'), nonce));
  }
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  return res.sendFile(indexPath);
});

// 独立初始化页面（/setup.html）：仅在未初始化时可访问，已初始化则重定向到 /admin
app.get('/setup.html', (req, res) => {
  if (getAdminToken()) {
    return res.redirect(302, '/admin');
  }
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});
app.get('/setup', (req, res) => res.redirect(302, '/setup.html'));

// admin 路由由 SPA 接管：网络层 IP 白名单闸 + 显式返回 SPA 入口
// 正则覆盖裸 /admin 与 /admin/*（Express 4 中 /admin/* 不匹配裸 /admin）
app.get(/^\/admin(\/.*)?$/, ipWhitelist, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// 旧书签 / 外链兼容：/admin.html 301 到 /admin
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
// 同源自定义 CSS 端点（M-1 修复）：以 <link> 投放而非内联 <style>，
// 既让 custom_css 在严格 CSP（style-src 'self'）下真正生效，又避免内联注入。
// 内容为落库前已清洗的版本；公开可读（仅样式，无敏感数据），并对所有访客生效。
app.get('/custom.css', (req, res) => {
  const css = sanitizeCss(db.getUiSettings().custom_css || '');
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.send(css);
});

// 统一 SPA fallback：处理 / 及所有前端深链
app.get('*', (req, res, next) => {
  // API 与显式路由已注册在前，不会落到此处
  if (req.path.startsWith('/api') || req.path.startsWith('/themes')) return next();

  // Vue SPA 内部路由前缀优先：这些路径不应被第三方主题吞掉
  const SPA_PREFIXES = ['/admin', '/login', '/node'];
  const isSpaRoute = SPA_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'));

  // 支持 ?theme=<id> 预览（无需改动设置，便于调试第三方皮肤）
  const ui = db.getUiSettings();
  const theme = (req.query.theme && typeof req.query.theme === 'string')
    ? req.query.theme
    : (ui.public_theme || 'default');

  // 带后缀文件：优先尝试当前主题根目录映射，未命中再交给 express.static
  if (path.extname(req.path)) {
    if (!isSpaRoute && theme && theme !== 'default' && /^[A-Za-z0-9_-]+$/.test(theme)) {
      const fp = path.join(THEMES_DIR, theme, req.path);
      // 防路径穿越（与上方 /themes/:id 显式路由的守卫一致）：req.path 原样来自请求行，
      // `?theme=<非default>` 可被任意访问者指定，join 归一化后必须仍落在主题目录内，
      // 否则可读任意带扩展名文件（活体 PoC：8 层 ../ 读出 /etc/resolv.conf）。
      if (!fp.startsWith(THEMES_DIR + path.sep)) return next();
      if (fs.existsSync(fp) && !fs.statSync(fp).isDirectory()) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        const ext = path.extname(fp).toLowerCase();
        res.setHeader('Content-Type', THEME_MIME[ext] || 'application/octet-stream');
        return serveFileStream(res, fp);
      }
    }
    return next();
  }

  // 无后缀路径：SPA 路由直接返回 Vue 入口
  if (isSpaRoute) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }

  // 无后缀：返回主题 index.html（官方主题在 dist/ 下也按根目录 index.html 处理）
  if (theme && theme !== 'default' && /^[A-Za-z0-9_-]+$/.test(theme)) {
    const fp = path.join(THEMES_DIR, theme, 'index.html');
    if (fs.existsSync(fp)) {
      // 第三方社区主题页：用一次性 nonce 放宽 CSP，仅覆盖本次响应。
      // admin.html / setup.html / api 等其他路由仍走全局严格 CSP，不受影响。
      if (THEME_NEEDS_NONCE.has(theme)) {
        const nonce = crypto.randomBytes(16).toString('base64');
        res.setHeader('Content-Security-Policy', themeRelaxedCsp(nonce));
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        return res.send(injectNonce(fs.readFileSync(fp, 'utf8'), nonce));
      }
      return res.sendFile(fp);
    }
  }
  // 无后缀 + 非 SPA 前缀 + default 主题（如 /nope）：同样返回 Vue 入口，由前端
  // catch-all 路由渲染统一 404 页。此前落到 Express 默认 "Cannot GET /xxx"，
  // 与 SPA 内部导航的 404 页体验割裂；未知路径本无服务端语义，统一交给前端处理。
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 禁用 JS/CSS/SVG/HTML 的浏览器/CDN 缓存，确保更新后立即生效
app.use((req, res, next) => {
  if (/\.(js|css|svg|html?)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Komari 社区主题兼容兜底：第三方主题（如 glassmorphism）硬编码以根路径
// /images/logo/* 与 /images/flags/* 取 OS logo / 国旗，而 diting 原生将其平铺在
// public/ 根（os-*.svg、flags/），目录层级不同会 404。此处仅在静态资源未命中时，
// 按当前启用主题回退到 themes/<id>/images/ 目录（那里本就含完整 logo/flags 集），
// 既满足 Komari 主题约定，又不复制/改动 diting 原生 public/ 布局。
const KOMARI_IMAGE_PREFIXES = ['/images/logo/', '/images/flags/'];
app.use((req, res, next) => {
  const p = req.path;
  if (!KOMARI_IMAGE_PREFIXES.some(pre => p.startsWith(pre))) return next();
  const ui = db.getUiSettings();
  const theme = ui.public_theme;
  if (!theme || theme === 'default' || !/^[A-Za-z0-9_-]+$/.test(theme)) return next();
  const sub = p.slice('/images/'.length); // logo/os-x.svg 或 flags/CN.svg
  const baseDir = path.join(THEMES_DIR, theme, 'images');
  const fp = path.join(baseDir, sub);
  if (!fp.startsWith(baseDir + path.sep)) return next(); // 防路径穿越
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return next();
  const ext = path.extname(fp).toLowerCase();
  res.setHeader('Content-Type', THEME_MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  return serveFileStream(res, fp);
});

// periodic prune of old metrics
// 保留天数从后台设置动态读取（db.getRetentionDays），设置变更后下次清理自动生效。
let pruneFails = 0;
let lastRetention = 0;
function runPrune() {
  const retentionDays = db.getRetentionDays();
  if (retentionDays !== lastRetention) {
    console.log(`[prune] retention ${lastRetention}d → ${retentionDays}d`);
    lastRetention = retentionDays;
  }
  try {
    const n = db.prune(retentionDays);
    if (n > 0) console.log(`[prune] removed ${n} old metrics (retention ${retentionDays}d)`);
    // 同步清理 AI 报告（按 ai_config.log_retention_days，独立于 metrics 保留期）
    const aiRetention = db.getAiConfig().log_retention_days || 30;
    const na = db.pruneAiReports(aiRetention);
    if (na > 0) console.log(`[prune] removed ${na} old ai_reports (retention ${aiRetention}d)`);
    // 单节点分析历史共用同一保留期（§8 T17）
    const nn = db.pruneAiNodeReports(aiRetention);
    if (nn > 0) console.log(`[prune] removed ${nn} old ai_node_reports (retention ${aiRetention}d)`);
    // 审计日志独立保留期（体检 L-3）：默认 90 天，AUDIT_RETENTION_DAYS 可调（下限 7）。
    // 此前 pruneAudit 已实现且已导出但全仓无调用方 → audit_logs 无限增长，违背 90 天承诺。
    const auditDays = Math.max(7, Number(process.env.AUDIT_RETENTION_DAYS || 90));
    const nAud = db.pruneAudit(auditDays);
    if (nAud > 0) console.log(`[prune] removed ${nAud} old audit_logs (retention ${auditDays}d)`);
    pruneFails = 0;
  } catch (e) {
    console.error('[prune] error', e.message);
    pruneFails++;
    // 持续失败（每小时一次，第 3 次）才发告警，避免瞬态失败刷屏；长期不清理会导致 metrics 表无限膨胀。
    if (pruneFails >= 3) {
      alerts.sendAlert('[监控] 数据清理(prune)持续失败', `metrics 清理已连续 ${pruneFails} 次失败：${e.message}。若长期不清理，metrics 表将持续膨胀，请检查数据库权限/磁盘空间。`);
      pruneFails = 0;
    }
  }
}
runPrune();
// unref：清理循环不应阻止进程退出（对集成测试尤其重要，否则测试进程会因该定时器挂起）
setInterval(runPrune, 3600 * 1000).unref();

const PORT = Number(process.env.PORT || 8081);
const server = app.listen(PORT, () => {
  console.log(`[monitor] server listening on :${PORT}`);
  alerts.start();
  ai.start();
});

// 第三方主题兼容 WebSocket：主题通过 ws://host/api/clients 发送 "get" 获取实时快照。
// 依赖 ws 包；若未安装则降级（REST 兼容接口 /api/public、/api/nodes、/api/recent 仍可用）。
// M-5：公开快照端点无鉴权，需限制资源消耗：① 仅当 public_enabled 开启才开放；
// ② 按客户端 IP 限制并发连接数与新建速率，防资源耗尽型攻击。
const WS_MAX_CONCURRENT = 5;   // 单 IP 最大并发连接
const WS_MAX_PER_MIN = 20;     // 单 IP 每分钟最大新建连接数
const wsConns = new Map();     // ip -> Set(ws)
const wsHits = new Map();      // ip -> { reset, count }
// 审查 C3/C-3：计数走公共实现（惰性过期 + 淘汰最旧）；原整表 clear 定时器会把
// 60s 窗口截断到 1s，攻击者跨重置边界可得 2 倍新建配额，已移除。

// ── 公开快照共享缓存（PR-10 / 体检 Section 06）─────────────────────────────
// 原先 /api/clients（每连接 5s）、/api/clients/sse（每连接 5s）各自调用并序列化
// compat.snapshot()：N 个连接 = N 次 DB 读取 + N 次 JSON.stringify。
// 现提升到模块级，全局每 5s 只构造一次，所有消费者（WS 广播 + SSE 各自 write）复用。
let publicSnapStr = '';
setInterval(() => {
  try { publicSnapStr = JSON.stringify(compat.snapshot()); } catch (_) { /* 保留上次快照 */ }
}, 5000).unref?.();
try { publicSnapStr = JSON.stringify(compat.snapshot()); } catch (_) { /* 首连前构造失败则等下次定时器 */ }
function wsClientIp(req) {
  // 只用 TCP 源地址，不读 X-Forwarded-For。XFF 可被直连攻击者伪造，
  // 用于绕过 WebSocket 并发/速率限制。req.socket.remoteAddress 是真实连接源，不可伪造。
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
// 共用限流函数：/api/clients 与 /api/rpc2 共享同一套并发/速率计数器
function wsRateLimit(ip) {
  if (!rateLimitTouch(wsHits, ip, 60000, WS_MAX_PER_MIN)) return false;
  let set = wsConns.get(ip);
  if (!set) { set = new Set(); wsConns.set(ip, set); }
  if (set.size >= WS_MAX_CONCURRENT) return false;
  return set;
}
try {
  const { WebSocketServer } = require('ws');

  // 单一 WebSocketServer（noServer 模式），在 upgrade 事件中按 path 分发给不同主题协议。
  // 注意：不可为 /api/clients 与 /api/rpc2 各建一个非 noServer 的 WSS 共享同一 server——
  // 那样 path 不匹配的 upgrade 会被第一个 WSS 以 HTTP 400 拒绝（ws 库默认行为），
  // 导致主题连接 /api/rpc2 失败、实时/负载数据全部拉不到。
  const wss = new WebSocketServer({ noServer: true });

  function attachCommon(ws, req) {
    if (!db.getUiSettings().public_enabled) {
      try { ws.close(1008, 'public disabled'); } catch (_) {}
      return;
    }
    const ip = wsClientIp(req);
    const set = wsRateLimit(ip);
    if (!set) {
      try { ws.close(1008, 'rate limited'); } catch (_) {}
      return;
    }
    set.add(ws);
    return set;
  }

  // /api/clients 专用连接集合（与 /api/rpc2 隔离：后者收到 clients 快照会解析出错）。
  const clientsSockets = new Set();
  // 全局广播：替代原先「每连接一个 5s 定时器」，连接数增长时成本恒定。
  const clientsBroadcastTimer = setInterval(() => {
    if (!publicSnapStr) return;
    for (const c of clientsSockets) {
      try { c.send(publicSnapStr); } catch (_) {}
    }
  }, 5000);
  if (clientsBroadcastTimer.unref) clientsBroadcastTimer.unref();

  // /api/clients：社区主题公开快照（发送 "get" 触发刷新）
  wss.on('connection', (ws, req, pathname) => {
    if (pathname !== '/api/clients') return;
    const set = attachCommon(ws, req);
    if (!set) return;
    // 发送共享快照字符串（零序列化成本）；空字符串表示尚未构造成功，跳过本轮
    const send = () => { if (publicSnapStr) { try { ws.send(publicSnapStr); } catch (_) {} } };
    clientsSockets.add(ws);
    send();
    ws.on('message', () => send());
    ws.on('close', () => {
      clientsSockets.delete(ws);
      set.delete(ws);
      if (set.size === 0) wsConns.delete(wsClientIp(req));
    });
  });

  // /api/rpc2 的状态推送同样改为共享快照（PR-10）：
  // 原实现每连接每 5s 调一次 getNodesLatestStatus() + 序列化，连接数 × 全量构造。
  let statusSnapStr = '';
  const statusSnapTimer = setInterval(() => {
    try {
      statusSnapStr = JSON.stringify({ jsonrpc: '2.0', result: compat.getNodesLatestStatus(), id: null });
    } catch (_) { /* 保留上次快照 */ }
  }, 5000);
  if (statusSnapTimer.unref) statusSnapTimer.unref();
  try {
    statusSnapStr = JSON.stringify({ jsonrpc: '2.0', result: compat.getNodesLatestStatus(), id: null });
  } catch (_) { /* 首连前构造失败时保持空串，下次定时器再试 */ }

  // /api/rpc2：社区主题 JSON-RPC 网关
  wss.on('connection', (ws, req, pathname) => {
    if (pathname !== '/api/rpc2') return;
    const set = attachCommon(ws, req);
    if (!set) return;

    const pushStatus = () => { if (statusSnapStr) { try { ws.send(statusSnapStr); } catch (_) {} } };
    pushStatus();

    ws.on('message', (data) => {
      let msg = null;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        // 非法 JSON：msg 未解析成功，用 null id 回复，不抛出以免崩进程。
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })); } catch (_) {}
        return;
      }
      // 审查 C4：handleRpc 异步化（内部重聚合走 worker 线程，不阻塞事件循环）
      Promise.resolve()
        .then(() => handleRpc(msg.method, msg.params))
        .then((result) => {
          try { ws.send(JSON.stringify({ jsonrpc: '2.0', result, id: msg.id })); } catch (_) {}
        })
        .catch((err) => {
          try {
            ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: err.code || -32603, message: err.message || 'error' }, id: msg ? msg.id : null }));
          } catch (_) {}
        });
    });

    // 无每连接定时器需清理（状态推送已改由模块级 statusSnapTimer 广播）
    ws.on('close', () => {
      set.delete(ws);
      if (set.size === 0) wsConns.delete(wsClientIp(req));
    });
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname = req.url || '/';
    const q = pathname.indexOf('?');
    if (q >= 0) pathname = pathname.slice(0, q);
    if (pathname !== '/api/clients' && pathname !== '/api/rpc2') {
      // 非主题 WS 路径：交由其他 handler（若有），否则关闭避免悬挂。
      try { socket.destroy(); } catch (_) {}
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, pathname);
    });
  });
  console.log('[monitor] theme-compat WebSocket (/api/clients, /api/rpc2) enabled');
} catch (e) {
  console.warn('[monitor] theme-compat WebSocket 未启用（缺少 ws 包，仅 REST 兼容可用）：', e.message);
}

// SSE 端点 /api/clients/sse：覆盖仅支持 SSE（不支持 WebSocket）的社区主题。
// 与 WebSocket /api/clients 同构：受 public_enabled 约束，每 5s 推送一次 compat.snapshot()，
// 事件格式为「data: <json>\n\n」（浏览器 EventSource 原生消费）。
//
// 审查 C1/C-2 加固：
//   C1 — 与 WS 对称地按源 IP 限制并发连接数与新建速率（此前 SSE 完全无限制，
//        未认证即可开任意条长连接，每条各持一个 5s setInterval）。
//   C-2 — 背压自保：客户端只建连不读 socket 时 Node 写缓冲持续累积，
//          write 返回 false 且缓冲超上限即断连清定时器，防单连接 OOM
//          （per-IP 并发限制对此无效，必须叠加）。
// 计数器独立于 WS（wsHits/wsConns）：避免 SSE 流量耗尽 WS 限额或相互干扰。
const SSE_MAX_CONCURRENT = 5;              // 单 IP 最大并发 SSE 连接
const SSE_MAX_PER_MIN = 20;                // 单 IP 每分钟最大新建连接数
const SSE_MAP_CAP = 10000;                 // sseHits Map 上限，防大量不同 IP 撑爆内存
const SSE_MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 单连接写缓冲上限（16MB）
const sseConns = new Map();                // ip -> Set(res)
const sseHits = new Map();                 // ip -> { reset, count }
function sseRateLimit(ip) {
  const now = Date.now();
  // 惰性过期：只删过期条目，不清表——整表 clear 会把当前攻击者计数一并清零（审查 C3）
  if (sseHits.size >= SSE_MAP_CAP) {
    for (const [k, v] of sseHits) { if (now > v.reset) sseHits.delete(k); }
    if (sseHits.size >= SSE_MAP_CAP) return false; // 仍满：fail closed
  }
  let rec = sseHits.get(ip);
  if (!rec || now > rec.reset) rec = { reset: now + 60000, count: 0 };
  rec.count++;
  sseHits.set(ip, rec);
  if (rec.count > SSE_MAX_PER_MIN) return false;
  let set = sseConns.get(ip);
  if (!set) { set = new Set(); sseConns.set(ip, set); }
  if (set.size >= SSE_MAX_CONCURRENT) return false;
  return set;
}
try {
  app.get('/api/clients/sse', (req, res) => {
    if (!db.getUiSettings().public_enabled) {
      return res.status(403).json({ status: 'error', message: 'public page disabled' });
    }
    // 与 WS 一致：只用 TCP 源地址判定，不读可伪造的 X-Forwarded-For
    const ip = wsClientIp(req);
    const set = sseRateLimit(ip);
    if (!set) {
      return res.status(429).json({ status: 'error', message: 'too many sse connections' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // 禁用 Nginx 缓冲，确保实时推送
    });
    // PR-10：复用模块级共享快照，不再每连接独立序列化（N 连接 = N 次构造）
    let timer = null;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      set.delete(res);
      if (set.size === 0) sseConns.delete(ip);
    };
    const send = () => {
      if (closed || res.writableEnded || !publicSnapStr) return;
      let ok = false;
      try { ok = res.write('data: ' + publicSnapStr + '\n\n'); } catch (_) { ok = false; }
      // 背压：write 返回 false 且 socket 缓冲超上限 → 客户端不读，断连自保
      if (!ok && res.socket && res.socket.writableLength > SSE_MAX_BUFFER_BYTES) {
        try { res.destroy(); } catch (_) {}
        cleanup();
      }
    };
    send();
    timer = setInterval(send, 5000);
    req.on('close', cleanup);
    res.on('close', cleanup); // 双保险：req/res 的 close 时序在不同 Node 版本有差异
    set.add(res);
  });
  console.log('[monitor] theme-compat SSE /api/clients/sse enabled (per-ip limit + backpressure)');
} catch (e) {
  console.warn('[monitor] theme-compat SSE 未启用：', e.message);
}

// ---- 统一错误处理 ----
// 必须注册在所有路由/中间件之后：Express 的 next(err) 只会查找「之后注册」的错误中间件，
// 而本文件中 WebSocket(≈407 行起) 与 SSE(≈509 行起) 都注册在 app.listen 之后，
// 所以这里放在文件末尾才能覆盖全部路由。
// 覆盖三类：① express.json 非法 JSON ② 超过 16kb 负载 ③ asyncHandler 转发的 rejection / 同步 throw。
// 安全约束：绝不把 err.stack / err.message 返回客户端（信息泄露），只落地日志。
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  console.error('[error]', req.method, req.originalUrl, '->', err && err.message);
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'invalid json' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload too large' });
  }
  res.status(500).json({ error: 'internal error' });
});

// 导出 app / server 供集成测试（supertest）使用。被 require 时若未设置 PORT
// 仍会监听默认 8081，故测试必须在 require 前置 process.env.PORT = '0' 取随机端口。
module.exports = { app, server };
