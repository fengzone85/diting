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
const { safeEqual, ipWhitelist } = require('./src/auth');
const { sanitizeCss } = require('./src/validate');

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

const app = express();
// 信任前置反代（Nginx）的 X-Forwarded-*，使 req.ip 取到真实客户端 IP，
// 供应用层限流按客户端区分（而非全部归到 127.0.0.1）。Nginx 已设置 X-Forwarded-For。
app.set('trust proxy', true);

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
// 如果 .env 未设 ADMIN_TOKEN，首次访问时走 Web 初始化向导生成 Token（保存到 ./data/admin_token.txt）。
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (ADMIN_TOKEN && ADMIN_TOKEN !== 'change-me-admin-token' && ADMIN_TOKEN.length >= 16) {
  console.log('[info] ADMIN_TOKEN 已从 .env 读取');
} else {
  console.warn('[warn] .env 中未设置 ADMIN_TOKEN，首次访问将走 Web 初始化向导。');
}

app.use(express.json({ limit: '16kb' }));

// ---- Prometheus /metrics 导出（P3：可观测性）----
// 通过 Bearer Token 鉴权（复用 ADMIN_TOKEN，恒定时间比较），不强制 https，便于内网抓取。
// 例：curl -H "Authorization: Bearer $ADMIN_TOKEN" http://host:8081/metrics
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
  if (!process.env.ADMIN_TOKEN) {
    return res.status(401).set('Content-Type', 'text/plain').send('401 ADMIN_TOKEN not configured');
  }
  const auth = req.header('Authorization') || '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!t || !safeEqual(t, process.env.ADMIN_TOKEN)) {
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
      req.path === '/me' || req.path === '/nodes' || req.path === '/recent' ||
      req.path === '/records/load' || req.path === '/records/ping' ||
      req.path === '/version' || req.path === '/rpc2' || req.path === '/clients/sse') return next();
  ipWhitelist(req, res, next);
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
    return fs.createReadStream(fp).pipe(res);
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

// 版本信息端点（公开）：供前端页脚显示版本号与构建时间
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION, build_time: APP_BUILD_TIME });
});

// 独立初始化页面（/setup.html）：仅在未初始化时可访问，已初始化则重定向到 /admin
app.get('/setup.html', (req, res) => {
  const { getAdminToken } = require('./src/auth');
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
      if (fs.existsSync(fp) && !fs.statSync(fp).isDirectory()) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        const ext = path.extname(fp).toLowerCase();
        res.setHeader('Content-Type', THEME_MIME[ext] || 'application/octet-stream');
        return fs.createReadStream(fp).pipe(res);
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
  next();
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
    pruneFails = 0;
  } catch (e) {
    console.error('[prune] error', e.message);
    pruneFails++;
    // 持续失败（默认每 3 小时一次）才发告警，避免瞬态失败刷屏；长期不清理会导致 metrics 表无限膨胀。
    if (pruneFails >= 3) {
      alerts.sendAlert('[监控] 数据清理(prune)持续失败', `metrics 清理已连续 ${pruneFails} 次失败：${e.message}。若长期不清理，metrics 表将持续膨胀，请检查数据库权限/磁盘空间。`);
      pruneFails = 0;
    }
  }
}
runPrune();
setInterval(runPrune, 3600 * 1000);

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
const WS_MAP_CAP = 10000;      // wsHits Map 最大条目数，防大量不同 IP 撑爆内存
const wsConns = new Map();     // ip -> Set(ws)
const wsHits = new Map();      // ip -> { reset, count }
setInterval(() => wsHits.clear(), 60000).unref?.();
function wsClientIp(req) {
  // 只用 TCP 源地址，不读 X-Forwarded-For。XFF 可被直连攻击者伪造，
  // 用于绕过 WebSocket 并发/速率限制。req.socket.remoteAddress 是真实连接源，不可伪造。
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
// 共用限流函数：/api/clients 与 /api/rpc2 共享同一套并发/速率计数器
function wsRateLimit(ip) {
  const now = Date.now();
  let rec = wsHits.get(ip);
  if (!rec || now > rec.reset) rec = { reset: now + 60000, count: 0 };
  rec.count++;
  if (wsHits.size >= WS_MAP_CAP) wsHits.clear();
  wsHits.set(ip, rec);
  if (rec.count > WS_MAX_PER_MIN) return false;
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

  // /api/clients：社区主题公开快照（发送 "get" 触发刷新）
  wss.on('connection', (ws, req, pathname) => {
    if (pathname !== '/api/clients') return;
    const set = attachCommon(ws, req);
    if (!set) return;
    const send = () => { try { ws.send(JSON.stringify(compat.snapshot())); } catch (_) {} };
    send();
    ws.on('message', () => send());
    const timer = setInterval(send, 5000);
    ws.on('close', () => {
      clearInterval(timer);
      set.delete(ws);
      if (set.size === 0) wsConns.delete(wsClientIp(req));
    });
  });

  // /api/rpc2：社区主题 JSON-RPC 网关
  wss.on('connection', (ws, req, pathname) => {
    if (pathname !== '/api/rpc2') return;
    const set = attachCommon(ws, req);
    if (!set) return;

    const pushStatus = () => {
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', result: compat.getNodesLatestStatus(), id: null }));
      } catch (_) {}
    };
    pushStatus();
    const timer = setInterval(pushStatus, 5000);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const result = handleRpc(msg.method, msg.params);
        ws.send(JSON.stringify({ jsonrpc: '2.0', result, id: msg.id }));
      } catch (err) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: err.code || -32603, message: err.message || 'error' }, id: msg?.id ?? null }));
      }
    });

    ws.on('close', () => {
      clearInterval(timer);
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
try {
  app.get('/api/clients/sse', (req, res) => {
    if (!db.getUiSettings().public_enabled) {
      return res.status(403).json({ status: 'error', message: 'public page disabled' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // 禁用 Nginx 缓冲，确保实时推送
    });
    const send = () => {
      try { res.write('data: ' + JSON.stringify(compat.snapshot()) + '\n\n'); } catch (_) {}
    };
    send();
    const timer = setInterval(send, 5000);
    req.on('close', () => clearInterval(timer));
  });
  console.log('[monitor] theme-compat SSE /api/clients/sse enabled');
} catch (e) {
  console.warn('[monitor] theme-compat SSE 未启用：', e.message);
}
