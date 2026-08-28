const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const db = require('./db');
const { agentAuth, adminOrReadonly, adminOnly, requireAdmin, safeEqual, setSessionCookie, clearSessionCookie, SESSION_TTL, requireProto, auditLog } = require('./auth');
const totp = require('./totp');
const alerts = require('./alerts');
const { daysUntil } = require('./util');

// 展示用 hostname 脱敏：带域名时只取最左标签（二级名），隐去后续域名；
// 纯 IP / 无点则原样，避免误截。例：pt5.521.be -> pt5；192.168.1.10 -> 原样。
function shortHost(h) {
  if (!h) return '';
  h = String(h).trim();
  const i = h.indexOf('.');
  if (i < 0) return h;                            // 无点（如 Feng / localhost）原样
  const suffix = h.slice(i + 1);
  if (/[a-zA-Z]/.test(suffix)) return h.slice(0, i); // 后缀含字母 => 域名，取二级名
  return h;                                        // 后缀纯数字 => 疑似 IP，原样保留
}

// 把 metrics.disks（TEXT 存储的 JSON 数组）安全解析为数组，供前端多盘渲染。
function parseDisks(s) {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

// 应用层限流（兜底，不依赖 Nginx）：每 IP 每 10s 最多 20 次。
// /report 已由 Nginx 单独限流，此处放行。trust proxy 已在 server.js 启用，req.ip 为真实客户端。
// MAP_CAP：限流 Map 最大条目数，超出则提前清空，防分布式攻击用大量不同 IP 撑爆内存。
// 放宽到每 IP 每 10s 60 次：单标签页前端每 5s 约 4 请求(8/10s)，
// 多标签页/多设备共享同一源 IP 时极易超过 20 次阈值而误伤正常浏览。
// 应用层限流仅为兜底，真实安全边界仍由 Nginx limit_req 承担。
const RATE_WINDOW = 10000, RATE_MAX = 60, MAP_CAP = 10000;
const rateHits = new Map();
setInterval(() => rateHits.clear(), RATE_WINDOW).unref?.();
const rateLimit = (req, res, next) => {
  if (req.path === '/report') return next();
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const rec = rateHits.get(ip);
  if (!rec || now > rec.reset) {
    if (rateHits.size >= MAP_CAP) rateHits.clear();
    rateHits.set(ip, { reset: now + RATE_WINDOW, count: 1 });
    return next();
  }
  rec.count++;
  if (rec.count > RATE_MAX) return res.status(429).json({ error: 'too many requests' });
  next();
};
router.use(rateLimit);

// ---- 登录专项限流（M-5 修复）----
// 全局限流（20次/10s）对登录来说太宽松：攻击者仍可以 20 次/10s 的速度尝试 Token。
// 此处对 /api/login 单独收紧到每 IP 每 60s 最多 5 次，大幅降低暴力破解效率。
// Admin Token 为 256 位随机值，理论上不可暴力破解；此限流主要防日志刷屏与资源消耗。
const LOGIN_WINDOW = 60000, LOGIN_MAX = 5;
const loginHits = new Map();
setInterval(() => loginHits.clear(), LOGIN_WINDOW).unref?.();
const loginRateLimit = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  let rec = loginHits.get(ip);
  if (!rec || now > rec.reset) {
    if (loginHits.size >= MAP_CAP) loginHits.clear();
    loginHits.set(ip, { reset: now + LOGIN_WINDOW, count: 1 });
    return next();
  }
  rec.count++;
  loginHits.set(ip, rec);
  if (rec.count > LOGIN_MAX) {
    return res.status(429).json({ error: 'too many login attempts, retry in 60s' });
  }
  next();
};

// ---- helpers ----
const { num, str, validateReport, sanitizeCss } = require('./validate');
// Admin Token 唯一来源：环境变量 ADMIN_TOKEN（与 auth.js 保持一致）。
function getAdminToken() {
  const t = process.env.ADMIN_TOKEN;
  if (t && t !== 'change-me-admin-token' && t.length >= 16) return t;
  return '';
}

// ---- 首次部署初始化向导 ----
router.get('/setup/status', (req, res) => {
  res.json({ needs_setup: !getAdminToken() });
});
// 初始化端点限流（纵深防御）：每 IP 每 60s 最多 5 次，防止未授权时暴力/竞态抢占。
const SETUP_WINDOW = 60000, SETUP_MAX = 5;
const setupHits = new Map();
setInterval(() => setupHits.clear(), SETUP_WINDOW).unref?.();
const setupRateLimit = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  let rec = setupHits.get(ip);
  if (!rec || now > rec.reset) rec = { reset: now + SETUP_WINDOW, count: 0 };
  rec.count++;
  if (setupHits.size >= MAP_CAP) setupHits.clear();
  setupHits.set(ip, rec);
  if (rec.count > SETUP_MAX) return res.status(429).json({ error: 'too many requests' });
  next();
};
// 初始化端点：仅在「无任何有效 Token」时可用。一旦生成本端点永久失效（返回 410 Gone），
// 后续重置 Token 只能通过 SSH 运行 diting.sh --reset-admin-token，彻底杜绝 Web 重置风险。
router.post('/setup/generate', setupRateLimit, (req, res) => {
  // 任何有效 Token 存在一律拒绝，返回 410 Gone
  if (getAdminToken()) {
    return res.status(410).json({
      error: 'already initialized',
      message: '管理员 Token 已存在，本端点已永久禁用。重置 Token 请通过 SSH 运行：sudo bash diting.sh --reset-admin-token'
    });
  }
  // 生成新 Token 并写入 .env（唯一来源）
  const token = 'adm_' + crypto.randomBytes(16).toString('hex');
  const envPath = path.join(__dirname, '..', '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf-8'); } catch { /* .env 不存在则创建 */ }
    // 替换已有的 ADMIN_TOKEN 行，或在文件末尾追加
    if (/^ADMIN_TOKEN=/m.test(content)) {
      content = content.replace(/^ADMIN_TOKEN=.*/m, `ADMIN_TOKEN=${token}`);
    } else {
      content += (content.endsWith('\n') ? '' : '\n') + `ADMIN_TOKEN=${token}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf-8');
    // 同步更新进程环境变量，使本次启动后续请求即可用
    process.env.ADMIN_TOKEN = token;
    console.log('[setup] 管理员 Token 已生成并写入 .env，此后 /api/setup/generate 永久禁用');
    res.json({ token });
  } catch (e) {
    console.error('[setup] 写入 .env 失败:', e.message);
    res.status(500).json({ error: 'write_failed', message: '写入 .env 失败：' + e.message });
  }
});

// ---- 一键安装命令生成（Nezha 风格：服务端把地址 + 每客户端令牌预填进命令）----
// 三条接入路径：① 原生版（Linux systemd + Python，diting.sh 自举下载配套文件）；
// ② Docker 版（现场从源码 git 构建镜像并运行，无需任何仓库账号）；
// ③ Windows 版（PowerShell 一键：下载 install.ps1 → 自举拉取 agent 载荷 → 注册计划任务）。
// 仓库 raw 基址（diting.sh 位于根，agent 载荷位于 <base>/agent/）；可用 AGENT_RAW_REPO 覆盖。
const REPO_BASE = (process.env.AGENT_RAW_REPO || 'https://raw.githubusercontent.com/fengzone85/diting/master').replace(/\/+$/, '');
const AGENT_GIT_REPO = process.env.AGENT_GIT_REPO || 'https://github.com/fengzone85/diting.git#master:agent';
const AGENT_INTERVAL_DEFAULT = Number(process.env.AGENT_INTERVAL || 20);

// 受控端接入用的服务端公网地址：优先级为
// ① UI 设置中「Agent 连接地址」② UI 设置中「项目网址」③ 环境变量 PUBLIC_URL ④ 从请求头自动推导。
function getPublicBaseUrl(req) {
  const ui = db.getUiSettings();
  if (ui && ui.agent_server_url) return ui.agent_server_url.replace(/\/+$/, '');
  if (ui && ui.site_url) return ui.site_url.replace(/\/+$/, '');
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  // 最后兜底：从请求头推导。记录告警提示管理员配置 agent_server_url 或 PUBLIC_URL，
  // 避免 X-Forwarded-Host 被攻击者注入导致一键安装命令指向恶意服务器。
  if (!getPublicBaseUrl._warned) {
    console.warn('[warn] getPublicBaseUrl: 未配置 agent_server_url/site_url/PUBLIC_URL，从请求头推导（建议显式配置以防 X-Forwarded-Host 注入）');
    getPublicBaseUrl._warned = true;
  }
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim() || 'https';
  const host = req.get('host');
  if (!host) return 'http://localhost:8081';
  return `${proto}://${host}`;
}

// Nezha 风格：一条命令搞定对接。原生版走根 diting.sh（自动拉取 agent 载荷并装 systemd）；
// Docker 版现场从源码 git 构建镜像并运行，无需任何仓库账号。
// probeTargets：网络质量自测目标（格式 label:host[:port] 逗号分隔），服务端可配置；
// 为空则受控端回退到各自代码里的内置默认。部署时直接写进安装命令，免去手动改环境变量。
// Shell 引号辅助：serverUrl/token/probeTargets 等动态字段可能含 shell 元字符，
// 拼入生成的安装命令前必须整体加引号，避免破坏命令结构或被注入。
// POSIX sh 单引号转义：整体单引号包裹，内部 ' 替换为 '\''。
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
// PowerShell 单引号字符串：内部 ' 翻倍为 ''。
function psQuote(s) {
  return `'${String(s).replace(/'/g, `''`)}'`;
}
function buildInstallCommands(serverUrl, agentId, agentToken, interval, probeTargets) {
  const iv = interval || AGENT_INTERVAL_DEFAULT;
  const ptArg = probeTargets ? ` --probe-targets ${shQuote(probeTargets)}` : '';
  const ptEnv = probeTargets ? ` -e PROBE_TARGETS=${shQuote(probeTargets)}` : '';
  const ptWin = probeTargets ? ` -ProbeTargets ${psQuote(probeTargets)}` : '';
  // 原生版采用下载后执行风格：先下载成文件、chmod +x、再 sudo 执行（相对 curl|bash 更透明、可审阅）。
  const native = `curl -fsSL ${REPO_BASE}/diting.sh -o diting.sh
chmod +x diting.sh
sudo ./diting.sh --install-agent --repo ${REPO_BASE} --server ${shQuote(serverUrl)} --id ${shQuote(agentId)} --token ${shQuote(agentToken)} --interval ${iv}${ptArg}`;
  const docker = `docker build -t diting-agent ${AGENT_GIT_REPO} \\\n  && docker run -d --name diting-agent --restart unless-stopped \\\n     -e SERVER_URL=${shQuote(serverUrl)} -e AGENT_ID=${shQuote(agentId)} -e AGENT_TOKEN=${shQuote(agentToken)} -e INTERVAL=${iv}${ptEnv} \\\n     -v diting-state:/data \\\n     diting-agent`;
  // Windows 版：一条 PowerShell 命令。外层用双引号、内部一律单引号，避免引号嵌套。
  // install.ps1 会自举下载 windows_agent.py/win_collector.py/requirements.txt 到
  // %ProgramData%\diting-agent，并注册登录自启的计划任务。需以管理员身份运行。
  const windows = `powershell -NoProfile -ExecutionPolicy Bypass -Command "\`$p=Join-Path \`$env:TEMP 'sp-agent-install.ps1'; iwr '${REPO_BASE}/agent/windows/install.ps1' -OutFile \`$p -UseBasicParsing; & \`$p -RegisterTask -Repo '${REPO_BASE}/agent/windows' -ServerUrl ${psQuote(serverUrl)} -AgentId ${psQuote(agentId)} -AgentToken ${psQuote(agentToken)} -Interval ${iv}${ptWin}"`;
  return { server_url: serverUrl, native_cmd: native, docker_cmd: docker, windows_cmd: windows, probe_targets: probeTargets || '' };
}

// 免 Token 的「修改探测目标」命令：已有受控端换 DNS 时，无需重装 / 无需 Token。
// Linux 写 systemd drop-in 并重启；Windows 改 run_scheduled.bat 的 PROBE_TARGETS 行后重启计划任务。
function buildModifyCommands(serverUrl, agentId, probeTargets) {
  const pt = probeTargets || '';
  const linux = `sudo mkdir -p /etc/systemd/system/diting-agent.service.d
sudo tee /etc/systemd/system/diting-agent.service.d/probe.conf >/dev/null <<'EOF'
[Service]
Environment="PROBE_TARGETS=${pt}"
EOF
sudo systemctl daemon-reload
sudo systemctl restart diting-agent`;
  const win = `$id=${psQuote(agentId)}; $pt=${psQuote(pt)}
$bat=Join-Path $env:ProgramData "diting-agent\\run_scheduled.bat"
$lines=Get-Content $bat
if ($lines -match '^set PROBE_TARGETS=') {
  ($lines -replace '^set PROBE_TARGETS=.*', "set PROBE_TARGETS=$pt") | Set-Content $bat
} else {
  Add-Content $bat "set PROBE_TARGETS=$pt"
}
Stop-ScheduledTask -TaskName "HostMonitorAgent-$id"; Start-ScheduledTask -TaskName "HostMonitorAgent-$id"`;
  return { linux_cmd: linux, windows_cmd: win, probe_targets: pt };
}

// ---- Agent report (push) ----
router.post('/report', agentAuth, (req, res) => {
  const m = validateReport(req.body);
  if (!m || m.cpu === null || m.mem_total === null) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  const ts = Date.now();
  db.insertMetric(req.agent.id, Object.assign({ ts }, m));
  db.touchAgent(req.agent.id, m.os, m.hostname);
  res.json({ ok: true });
});

// ---- 一键脚本：受控端自助注册（受 SETUP_TOKEN 守卫）----
// 启用条件：服务端 .env 配置了 SETUP_TOKEN。受控端携带该令牌调用本端点，
// 服务端自动创建客户端并返回 id/token，使 agent 安装做到「只填域名+密钥」。
// 不建立任何指令通道——注册后 agent 仍只上报指标，服务端不持有其任何控制权。
// L-3：即便 SETUP_TOKEN 泄露，也对每个 IP 限流（默认每分钟 10 次），
// 防暴力枚举 agent 名称 / 资源耗尽。全局 rateLimit 已做兜底，此处更严格。
const REGISTER_WINDOW = 60000, REGISTER_MAX = 10;
const registerHits = new Map();
setInterval(() => registerHits.clear(), REGISTER_WINDOW).unref?.();
const registerRateLimit = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  let rec = registerHits.get(ip);
  if (!rec || now > rec.reset) rec = { reset: now + REGISTER_WINDOW, count: 0 };
  rec.count++;
  if (registerHits.size >= MAP_CAP) registerHits.clear();
  registerHits.set(ip, rec);
  if (rec.count > REGISTER_MAX) return res.status(429).json({ error: 'too many requests' });
  next();
};
router.post('/setup/register', registerRateLimit, (req, res) => {
  const setupToken = process.env.SETUP_TOKEN;
  if (!setupToken) {
    return res.status(403).json({ error: '服务端未启用一键注册（未配置 SETUP_TOKEN）' });
  }
  if (setupToken.trim().length < 16) {
    return res.status(403).json({ error: 'SETUP_TOKEN 过弱（至少 16 字符，建议 openssl rand -hex 16），一键注册已停用' });
  }
  const provided = (req.body && req.body.setup_token) || (req.headers['x-setup-token'] || '').trim();
  if (!provided || !safeEqual(provided, setupToken)) {
    return res.status(401).json({ error: 'invalid setup token' });
  }
  const { id, token } = db.createAgent({
    name: str(req.body.name, 100) || undefined,
    note: str(req.body.note, 500)
  });
  res.json({ agent_id: id, agent_token: token });
});

// ---- Admin: list agents + latest metric + online status ----
router.get('/agents', adminOrReadonly, (req, res) => {
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const list = db.getAgents().map((a) => {
    const latest = db.getLatestMetric(a.id);
    const online = a.last_seen && (now - a.last_seen) < offlineSec * 1000;
    const latestOut = latest ? Object.assign({}, latest, { disks: parseDisks(latest.disks) }) : null;
    return Object.assign({}, a, { group: a.grp || '', online: !!online, latest: latestOut, hostname: shortHost(a.hostname) });
  });
  res.json(list);
});

// ---- Admin: batch sparkline history for all agents (avoids N+1 on the frontend) ----
router.get('/agents/sparklines', adminOrReadonly, (req, res) => {
  const range = req.query.range;
  const sec = RANGES[range] || 21600;
  // 管理端 sparklines：用轻量列查询（不含 probes 大字段）+ SQL 层采样，避免 SELECT * 物化全行。
  const mp = clampInt(req.query.max_points, 60, 20000) || sparkMaxPoints(range);
  const rows = db.metricsSparklinesAllSampled(Date.now() - sec * 1000, mp);
  res.json(downsampleSparklines(rows, mp));
});

// ---- Admin: 集群平均 CPU/内存趋势（仪表盘专用）----
// 与 /agents/sparklines 不同：不做「每 agent 原始点」，而是由 SQL 引擎跨所有 agent 按时间桶
// 直接聚合出集群平均曲线，只返回 ≤maxPoints 行（几十~几百个点）。彻底消除前端拉 62 台全量
// 再逐点聚合的主线程卡顿。max_points 缺省用 sparkMaxPoints，与右侧趋势图桶粒度一致。
router.get('/agents/sparklines/overview', adminOrReadonly, (req, res) => {
  const range = req.query.range;
  const sec = RANGES[range] || 21600;
  const mp = clampInt(req.query.max_points, 60, 20000) || sparkMaxPoints(range);
  const rows = db.metricsClusterAvg(Date.now() - sec * 1000, sec * 1000, mp);
  // rows: [{ts, cpu, mem_pct}]，桶内已有集群平均，直接返回
  res.json(rows.map(r => ({
    ts: r.ts,
    cpu: r.cpu == null ? null : +r.cpu.toFixed(2),
    mem_pct: r.mem_pct == null ? null : +r.mem_pct.toFixed(2)
  })));
});

// ---- Admin: single agent info ----
router.get('/agents/:id', adminOrReadonly, (req, res) => {
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const latest = db.getLatestMetric(a.id);
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const online = a.last_seen && (Date.now() - a.last_seen) < offlineSec * 1000;
  const latestOut = latest ? Object.assign({}, latest, { disks: parseDisks(latest.disks) }) : null;
  res.json(Object.assign({}, a, { group: a.grp || '', online: !!online, latest: latestOut, hostname: shortHost(a.hostname) }));
});

// ---- Admin: metrics time-series ----
const RANGES = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
router.get('/agents/:id/metrics', adminOrReadonly, (req, res) => {
  const sec = RANGES[req.query.range] || 3600;
  const rows = db.getMetrics(req.params.id, Date.now() - sec * 1000);
  res.json(rows);
});

// ---- Admin: overview ----
// 在原有「总数/在线/离线/平均 CPU/内存」基础上，补充「流量概览」与「分组概览」，
// 供前端对标社区主题的流量/地区概览区块直接渲染。
router.get('/overview', adminOrReadonly, (req, res) => {
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const agents = db.getAgents();
  let online = 0, cpuSum = 0, memSum = 0, cnt = 0;
  let trafficUsedBytes = 0; // 本月累计流量（在线节点 latest 的收+发）
  let totalQuotaGB = 0;
  const groups = {}; // 分组 -> { total, online }
  for (const a of agents) {
    const isOn = a.last_seen && now - a.last_seen < offlineSec * 1000;
    if (isOn) {
      online++;
      const m = db.getLatestMetric(a.id);
      if (m) { cpuSum += m.cpu || 0; memSum += m.mem_pct || 0; cnt++; trafficUsedBytes += (m.net_rx_month || 0) + (m.net_tx_month || 0); }
    }
    const g = (a.grp || '').trim() || '未分组';
    const ge = groups[g] || (groups[g] = { total: 0, online: 0 });
    ge.total++;
    if (isOn) ge.online++;
    totalQuotaGB += Number(a.monthly_quota_gb) || 0;
  }
  res.json({
    total: agents.length,
    online,
    offline: agents.length - online,
    avg_cpu: cnt ? +(cpuSum / cnt).toFixed(1) : 0,
    avg_mem: cnt ? +(memSum / cnt).toFixed(1) : 0,
    traffic_used_bytes: Math.round(trafficUsedBytes),
    total_quota_gb: totalQuotaGB,
    groups: Object.keys(groups).map(name => ({ name, total: groups[name].total, online: groups[name].online })),
    // 数据库大小监控：SQLite 文件实际占用的磁盘字节数（含 journal）
    db_size_bytes: db.getDbFileSize()
  });
});

// ---- Admin: billing overview（月度费用 + 分组费用 + 7 天内到期列表）----
router.get('/billing', adminOrReadonly, (req, res) => {
  const agents = db.getAgents();
  let monthlyTotal = 0;
  const perGroup = {};
  const expiringSoon = [];
  for (const a of agents) {
    const price = Number(a.price) || 0;
    const cycle = Number(a.billing_cycle) || 30;
    const monthly = price > 0 && cycle > 0 ? price * (30 / cycle) : 0;
    monthlyTotal += monthly;
    const g = (a.grp || '').trim() || '未分组';
    perGroup[g] = (perGroup[g] || 0) + monthly;
    const daysLeft = daysUntil(a.expire_at);
    if (daysLeft !== null && daysLeft <= 7) {
      expiringSoon.push({ id: a.id, name: a.name, days_left: daysLeft });
    }
  }
  res.json({
    monthly_total: +monthlyTotal.toFixed(2),
    currency: '¥',
    agent_count: agents.length,
    per_group: Object.keys(perGroup).map(name => ({ name, cost: +perGroup[name].toFixed(2) })),
    expiring_soon: expiringSoon.sort((a, b) => a.days_left - b.days_left)
  });
});

// ---- Public（游客）视图：无需登录，受 ui_settings.public_enabled 控制 ----
// 返回脱敏概览（仅总数/在线/离线/分组），不含任何敏感指标均值。
function publicDisabled(res) { return res.status(403).json({ error: 'public view disabled' }); }
router.get('/public/overview', (req, res) => {
  const ui = db.getUiSettings();
  if (ui.public_enabled === false) return publicDisabled(res);
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const agents = db.getAgents();
  let online = 0;
  let cpuSum = 0, memSum = 0, cpuCount = 0, memCount = 0;
  const groups = {};
  for (const a of agents) {
    const isOn = a.last_seen && now - a.last_seen < offlineSec * 1000;
    if (isOn) {
      online++;
      const m = db.getLatestMetric(a.id);
      if (m) {
        if (typeof m.cpu === 'number') { cpuSum += m.cpu; cpuCount++; }
        if (typeof m.mem_pct === 'number') { memSum += m.mem_pct; memCount++; }
      }
    }
    const g = (a.grp || '').trim() || '未分组';
    const ge = groups[g] || (groups[g] = { total: 0, online: 0 });
    ge.total++; if (isOn) ge.online++;
  }
  res.json({
    total: agents.length, online, offline: agents.length - online,
    cpu_avg: cpuCount > 0 ? +(cpuSum / cpuCount).toFixed(1) : null,
    mem_avg: memCount > 0 ? +(memSum / memCount).toFixed(1) : null,
    groups: Object.keys(groups).map(name => ({ name, total: groups[name].total, online: groups[name].online }))
  });
});

// 返回脱敏的公开 agent 列表（不含 token / note / 商家 / 到期 / 配额等敏感字段）。
router.get('/public/agents', (req, res) => {
  const ui = db.getUiSettings();
  if (ui.public_enabled === false) return publicDisabled(res);
  const offlineSec = Number(process.env.OFFLINE_THRESHOLD_SEC || 60);
  const now = Date.now();
  const list = db.getAgents().map((a) => {
    const latest = db.getLatestMetric(a.id);
    const online = a.last_seen && (now - a.last_seen) < offlineSec * 1000;
    const m = online && latest ? latest : null;
    return {
      id: a.id, name: a.name, group: a.grp || '',
      country: a.country || '',
      online: !!online,
      cpu: m ? m.cpu : null,
      mem_pct: m ? m.mem_pct : null,
      mem_total: m ? m.mem_total : 0,
      mem_used: m ? m.mem_used : 0,
      disk_pct: m ? m.disk_pct : null,
      disk_used: m ? m.disk_used : 0,
      disk_total: m ? m.disk_total : 0,
      disk_r_rate: m ? m.disk_r_rate : 0,
      disk_w_rate: m ? m.disk_w_rate : 0,
      load1: m ? m.load1 : null,
      load5: m ? m.load5 : null,
      load15: m ? m.load15 : null,
      temp: m ? m.temp : null,
      swap_pct: m ? m.swap_pct : null,
      swap_used: m ? m.swap_used : 0,
      swap_total: m ? m.swap_total : 0,
      net_rx_rate: m ? m.net_rx_rate : 0,
      net_tx_rate: m ? m.net_tx_rate : 0,
      net_rx_month: m ? m.net_rx_month : 0,
      net_tx_month: m ? m.net_tx_month : 0,
      uptime: m ? m.uptime : 0,
      os: (m && m.os) ? m.os : (a.os || ''),
      probes: m ? (m.probes || '') : '',
      hostname: online ? shortHost(a.hostname) : '',
      merchant: a.merchant || '',
      expire_at: a.expire_at || '',
      note: a.note || '',
      monthly_quota_gb: a.monthly_quota_gb || 0,
      // 计费套餐字段（与 Komari price/billing_cycle/currency 对齐）
      price: a.price || 0,
      billing_cycle: a.billing_cycle || 30,
      currency: a.currency || '¥',
      disks: m ? parseDisks(m.disks) : []
    };
  });
  res.json(list);
});

// 公开历史曲线（脱敏，仅指标时序，无 token / 备注 / 商家等敏感字段）。
// 供「视觉版」首页卡片渲染 sparkline。受 ui.public_enabled 控制。
// 注意：无 id 的全量查询在 100 台规模下数据量巨大，后端做时间桶降采样（见 downsampleSparklines）
// 并把结果按 range+id 缓存 30s，避免前端并发刷新时重复跑大查询把服务端打挂（DoS 级瓶颈）。
const sparkCache = new Map(); // key: `${range}|${onlyId}` -> { ts, data }
const SPARK_CACHE_TTL = 30000;
// 无 id 全量请求（首页卡片迷你图）每 agent 点数上限：100 台规模下控制传输量
const SPARK_ALL_MAX_POINTS = 120;
router.get('/public/agents/sparklines', (req, res) => {
  const ui = db.getUiSettings();
  if (ui.public_enabled === false) return publicDisabled(res);
  const range = RANGES[req.query.range] ? req.query.range : '7d'; // 无效 range 兜底 7d
  const sec = RANGES[range];
  const onlyId = typeof req.query.id === 'string' && req.query.id ? req.query.id : null;
  const cacheKey = `${range}|${onlyId || '*'}`;
  const cached = sparkCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SPARK_CACHE_TTL) {
    return res.json(cached.data);
  }
  // 游客详情页只需单节点历史，避免拉全量；缺省行为保持全量兼容。
  // 用只含指标列（不含 probes 大字段）的轻量查询，避免 SELECT * 物化全行（30d 5.3s -> 2.3s）
  // 无 id 全量请求：SQL 层窗口函数采样（757K 行→~7200 行，减少 100x 传输+JS 处理）。
  // 有 id 单节点请求（详情页）：同样走 SQL 层采样 metricsSparklinesOne。
  //   此前单节点是「全量拉 10.8 万行 → Node 侧降采样」，每次 2.77s + 220MB 峰值，
  //   30s 缓存一过就慢/偶发超时（详情页图表"慢/有时无法显示"）。SQL 层直接只返回 maxPoints 行。
  const mp = clampInt(req.query.max_points, 60, 20000)
    || (onlyId ? sparkMaxPoints(range) : SPARK_ALL_MAX_POINTS);
  const t0 = Date.now();
  const rows = onlyId
    ? db.getMetricsSparklinesOne(onlyId, Date.now() - sec * 1000, mp)
    : db.metricsSparklinesAllSampled(Date.now() - sec * 1000, mp);
  // 后端降采样（对齐 Komari max_points 契约）。
  // 无 id 的全量请求（首页卡片迷你图，只需 ~120 点/agent）：用独立小上限 SPARK_ALL_MAX_POINTS，
  // 避免 100 台规模下返回 1500 点/agent 造成 40MB+ 传输灾难。
  // 有 id 的单节点请求（详情页磁盘耗尽预测）：SQL 层已按 range 上限采样（30d→2000 足够线性外推），
  // 此处 downsampleSparklines 仅作幂等兜底（SQL 采样已保留首尾点，若点数已≤mp 会原样返回）。
  const byAgent = downsampleSparklines(rows, mp);
  for (const id of Object.keys(byAgent)) {
    byAgent[id] = byAgent[id].map(r => ({
      ts: r.ts, cpu: r.cpu, mem_pct: r.mem_pct, disk_pct: r.disk_pct,
      net_rx_rate: r.net_rx_rate, net_tx_rate: r.net_tx_rate,
      load1: r.load1, temp: r.temp, swap_pct: r.swap_pct, uptime: r.uptime,
      disk_r_rate: r.disk_r_rate, disk_w_rate: r.disk_w_rate,
      // 磁盘耗尽预测用：整机已用/总字节时序（对齐 komari MetricDisk 口径）
      disk_used: r.disk_used, disk_total: r.disk_total
    }));
  }
  sparkCache.set(cacheKey, { ts: Date.now(), data: byAgent });
  res.json(byAgent);
});

// 后端降采样开关（对齐 Komari downsample/max_points 契约）：
//   PROBES_DOWNSAMPLE=1（默认）启用后端时间桶聚合 + 每 label 点数上限；
//   =0 关闭则原样返回桶内原始点（点数可能很大，供前端自行处理）。
//   PROBES_MAX_POINTS：每 label 点数硬上限，默认 5000，可调（上限钳到 50000）。
const PROBES_DOWNSAMPLE = process.env.PROBES_DOWNSAMPLE !== '0';
const PROBES_MAX_POINTS = (() => {
  const n = Number(process.env.PROBES_MAX_POINTS);
  return Number.isFinite(n) && n > 0 ? Math.min(50000, Math.floor(n)) : 5000;
})();
// 将任意输入钳为正整数，非法/越界返回 null
function clampInt(v, min = 1, max = 50000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

// ---- sparklines 后端降采样（对齐 Komari max_points 契约）----
// 卡片迷你图只需 ~60 点，磁盘耗尽预测需较长序列（~2000 点足够）。
// 全量 30d 单节点 9.5 万点，100 台规模下公开 sparklines 无 id 全量查询会雪崩（DoS 级）。
// 故按 range 给每 agent 设定点数上限，做时间桶聚合，避免传输/序列化灾难。
const SPARK_MAX_POINTS = {
  '1h': 300, '6h': 600, '24h': 1000, '7d': 1500, '30d': 2000
};
function sparkMaxPoints(range) {
  return SPARK_MAX_POINTS[range] || 2000;
}
// rows: [{ts, agent_id, ...metrics}]，按 agent_id 分组后组内时间桶降采样到 maxPoints。
// 桶内取最后一个点（时序曲线降采样用 last 即可，磁盘预测线性外推同样适用）。
function downsampleSparklines(rows, maxPoints) {
  const byAgent = {};
  for (const r of rows) {
    (byAgent[r.agent_id] || (byAgent[r.agent_id] = [])).push(r);
  }
  const out = {};
  for (const [agentId, arr] of Object.entries(byAgent)) {
    if (arr.length <= maxPoints) {
      out[agentId] = arr;
      continue;
    }
    const span = arr[arr.length - 1].ts - arr[0].ts;
    const bucket = Math.max(1, Math.ceil(span / maxPoints)); // 以 maxPoints 反推桶宽
    const map = new Map();
    const order = [];
    for (const r of arr) {
      const key = Math.floor(r.ts / bucket) * bucket;
      if (!map.has(key)) { map.set(key, r); order.push(key); }
      else map.set(key, r); // 同桶取最后一个点
    }
    out[agentId] = order.map(k => map.get(k));
  }
  return out;
}

// 公开单节点探针延迟历史（脱敏）：详情页 ping 值延迟分析图表用。
// 从 metrics.probes 历史读取，按探测点 label 归并，返回每个探测点的延迟时间序列。
// 受 ui.public_enabled 控制；range 支持 1h/6h/24h/7d。
router.get('/public/agents/:id/probes', (req, res) => {
  const ui = db.getUiSettings();
  if (ui.public_enabled === false) return publicDisabled(res);
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const sec = RANGES[req.query.range] || 21600;
  // 提前算出本请求的每 label 点数上限（供 SQL 层采样 + 后续桶聚合共用）。
  const reqMaxPoints = clampInt(req.query.max_points) || PROBES_MAX_POINTS;
  // 仅取 ts+probes 两列：30d 近 9.5 万行，SELECT * 物化全行开销大（实测 5.4s vs 0.56s）
  // 再叠加 SQL 层采样：全量 9.5 万行 → maxPoints 行，逐行 JSON.parse 次数同比骤降。
  // 采样点数取 max(上限, 5000) 的 3 倍冗余，保证后续 avg 桶聚合仍有足够样本、统计不失真。
  const rows = db.getMetricsProbesOne(a.id, Date.now() - sec * 1000, Math.min(20000, Math.max(reqMaxPoints, PROBES_MAX_POINTS) * 3));
  const series = {}; // label -> [{ts, ms}]
  for (const r of rows) {
    if (!r.probes) continue;
    let probes;
    try { probes = JSON.parse(r.probes); } catch (_) { continue; }
    if (!probes || typeof probes !== 'object') continue;
    for (const [label, p] of Object.entries(probes)) {
      if (!p || typeof p !== 'object') continue;
      if (!series[label]) series[label] = [];
      series[label].push({
        ts: r.ts,
        ms: typeof p.ms === 'number' ? Math.round(p.ms) : null,
        ok: p.ok !== false,
        loss: typeof p.loss === 'number' ? Math.round(p.loss) : (p.ok !== false ? 0 : 100)
      });
    }
  }
  if (PROBES_DOWNSAMPLE) {
    // 请求参数化降采样（对齐 Komari downsample/max_points/aggregation 契约）：
    //   max_points=N：每 label 目标点数上限（缺省用 PROBES_MAX_POINTS）。以该值反推动态桶宽做时间桶聚合。
    //   aggregation=avg|last：avg（默认，对齐 Komari）取桶内延迟平均；last 取桶内最后一个点。
    const maxPoints = reqMaxPoints;
    const agg = req.query.aggregation === 'last' ? 'last' : 'avg';
    for (const label of Object.keys(series)) {
      const arr = series[label];
      if (arr.length <= maxPoints) continue; // 点数本就不多，无需聚合
      const span = arr[arr.length - 1].ts - arr[0].ts;
      const bucket = Math.max(1, Math.ceil(span / maxPoints)); // 以 max_points 为目标反推桶宽
      const map = new Map();
      const order = [];
      for (const pt of arr) {
        const key = Math.floor(pt.ts / bucket) * bucket;
        if (!map.has(key)) {
          map.set(key, {
            ts: pt.ts,
            ms: pt.ms, // last 模式用桶内第一个点
            ok: pt.ok, loss: pt.loss,
            // avg 累加器
            sumMs: pt.ms != null ? pt.ms : 0, cntMs: pt.ms != null ? 1 : 0,
            okCnt: pt.ok ? 1 : 0, sumLoss: pt.loss != null ? pt.loss : 0, cnt: 1
          });
          order.push(key);
        } else {
          const cur = map.get(key);
          cur.ts = pt.ts;
          if (pt.ms != null) { cur.sumMs += pt.ms; cur.cntMs++; }
          if (pt.ok) cur.okCnt++;
          if (pt.loss != null) cur.sumLoss += pt.loss;
          cur.cnt++;
          if (agg === 'last' && pt.ms != null) cur.ms = pt.ms; // last 模式覆盖为桶内最后一个有效点
        }
      }
      series[label] = order.map(k => {
        const b = map.get(k);
        if (agg === 'avg') {
          return {
            ts: b.ts,
            ms: b.cntMs ? Math.round(b.sumMs / b.cntMs) : null,
            ok: b.okCnt > 0,
            loss: Math.round(b.sumLoss / b.cnt)
          };
        }
        return { ts: b.ts, ms: b.ms, ok: b.ok, loss: b.loss };
      });
    }
  }
  res.json(series);
});

// 游客视图元信息（无需登录）：站点标题、是否开放、首页默认布局、卡片排序。
router.get('/public/meta', (req, res) => {
  const ui = db.getUiSettings();
  let agentOrder = [];
  try { agentOrder = JSON.parse(db.getConfig('public_order') || '[]'); } catch (e) {}
  res.json({
    site_title: ui.site_title || '',
    site_url: ui.site_url || '',
    logo_url: ui.logo_url || '/logo.png',
    public_enabled: !!ui.public_enabled,
    home_layout: ui.home_layout || 'grid',
    agent_order: Array.isArray(agentOrder) ? agentOrder : [],
    social_email: ui.social_email || '',
    social_telegram: ui.social_telegram || '',
    social_qq: ui.social_qq || '',
    social_website: ui.social_website || '',
    // 主题可视化配置（对齐 komari-theme-Glassmorphism）
    glass_preset: ui.glass_preset || 'emerald',
    glass_custom: ui.glass_custom || {},
    color_vision: ui.color_vision || 'normal',
    card_scheme: ui.card_scheme || 'official',
    card_size: ui.card_size || 'comfortable',
    // 暗/亮两套背景配置（兼容旧版单 background 字段作为暗色回退）
    background_dark: ui.background_dark || ui.background || { enabled: false, type: 'image', url: '', blur: 8, overlay: 50 },
    background_light: ui.background_light || { enabled: false, type: 'image', url: '', blur: 8, overlay: 50 },
    announcement: ui.announcement || { enabled: false, title: '', content: '' },
    provider_aliases: ui.provider_aliases || {},
    custom_tags: ui.custom_tags || {},
    visitor_info: !!ui.visitor_info
  });
});

// 访客信息条（对齐 komari 主题的 visitorInfoEnabled）：返回访客 IP 与 UA 摘要。
router.get('/public/visitor', (req, res) => {
  const fwd = req.headers['x-forwarded-for'];
  let ip = req.ip || (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const ua = req.headers['user-agent'] || '';
  let browser = 'Unknown';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  res.json({ ip, browser, ua: ua.slice(0, 80) });
});

// 游客页卡片自定义排序（需管理员会话，避免游客随意更改全局顺序）。
// 管理员在前台拖拽后调用此接口，所有人访问即看到固定顺序。
router.post('/public/order', adminOnly, (req, res) => {
  const order = (req.body && Array.isArray(req.body.order))
    ? req.body.order.filter(x => typeof x === 'string').slice(0, 2000)
    : [];
  db.setConfig('public_order', JSON.stringify(order));
  res.json({ ok: true });
});

// 列出 public/themes/ 下的可用皮肤（供后台「皮肤模板」选择）。无需登录。
router.get('/public/themes', (req, res) => {
  const dir = path.join(__dirname, '..', 'public', 'themes');
  const list = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const meta = { id: e.name, name: e.name, author: '', description: '' };
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'manifest.json'), 'utf8'));
        if (m && typeof m === 'object') Object.assign(meta, m);
      } catch (_) {}
      list.push(meta);
    }
  } catch (_) {}
  res.json(list);
});

// ---- Admin: create agent ----
router.post('/agents', adminOnly, (req, res) => {
  // 探测目标：建客户端时未显式填写则回退到「设置」里的全局默认（不同地域可单独覆盖）。
  const ui = db.getUiSettings();
  const probeTargets = str(req.body.probe_targets, 600) || ui.probe_targets || '';
  const price = Number(req.body.price);
  const cycleNum = Number(req.body.billing_cycle);
  const { id, token } = db.createAgent({
    name: str(req.body.name, 100) || undefined,
    merchant: str(req.body.merchant, 100),
    note: str(req.body.note, 500),
    expire_at: str(req.body.expire_at, 40),
    monthly_quota_gb: req.body.monthly_quota_gb,
    price: Number.isFinite(price) ? Math.max(0, Math.min(99999, price)) : undefined,
    billing_cycle: Number.isFinite(cycleNum) && [0, 30, 60, 90, 180, 365, 730, 1095].includes(cycleNum) ? cycleNum : undefined,
    currency: ['¥', '$', '€', '£'].includes(req.body.currency) ? req.body.currency : undefined,
    auto_renewal: typeof req.body.auto_renewal === 'boolean' ? req.body.auto_renewal : undefined,
    grp: str(req.body.group, 60),
    country: str(req.body.country, 2),
    probe_targets: probeTargets
  });
  // 创建时一次性把「地址 + 该客户端令牌 + 探测目标」预填进一键命令返回（令牌仅此刻明文可用）。
  const install = buildInstallCommands(getPublicBaseUrl(req), id, token, AGENT_INTERVAL_DEFAULT, probeTargets);
  res.json({ id, token, install });
  auditLog(req, 'create_agent', `name=${req.body.name || ''} id=${id}`);
});

// ---- Admin: update agent metadata ----
router.put('/agents/:id', adminOnly, (req, res) => {
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const priceUp = Number(req.body.price);
  const cycleUp = Number(req.body.billing_cycle);
  const updates = {
    name: str(req.body.name, 100) || a.name,
    merchant: str(req.body.merchant, 100),
    note: str(req.body.note, 500),
    expire_at: str(req.body.expire_at, 40),
    monthly_quota_gb: req.body.monthly_quota_gb,
    grp: str(req.body.group, 60),
    country: str(req.body.country, 2),
    probe_targets: str(req.body.probe_targets, 600)
  };
  if (Number.isFinite(priceUp)) updates.price = Math.max(0, Math.min(99999, priceUp));
  if (Number.isFinite(cycleUp) && [0, 30, 60, 90, 180, 365, 730, 1095].includes(cycleUp)) updates.billing_cycle = cycleUp;
  if (['¥', '$', '€', '£'].includes(req.body.currency)) updates.currency = req.body.currency;
  if (typeof req.body.auto_renewal === 'boolean') updates.auto_renewal = req.body.auto_renewal;
  db.updateAgent(req.params.id, updates);
  res.json({ ok: true });
  auditLog(req, 'update_agent', `id=${req.params.id}`);
});

// ---- Admin: delete agent ----
router.delete('/agents/:id', adminOnly, (req, res) => {
  db.deleteAgent(req.params.id);
  res.json({ ok: true });
  auditLog(req, 'delete_agent', `id=${req.params.id}`);
});

// ---- Admin: reset an agent's token (returns new token; old one invalidated) ----
router.post('/agents/:id/reset-token', adminOnly, (req, res) => {
  const token = db.resetAgentToken(req.params.id);
  if (!token) return res.status(404).json({ error: 'not found' });
  // 重置后同样回带三条一键命令：用户直接复制重装即可，无需手改环境变量。
  // 探测目标沿用该受控端已保存的值，保证重装后 DNS 保持一致。
  const a = db.getAgent(req.params.id);
  const install = buildInstallCommands(getPublicBaseUrl(req), req.params.id, token, AGENT_INTERVAL_DEFAULT, a ? a.probe_targets : '');
  res.json({ ok: true, token, install });
  auditLog(req, 'reset_token', `id=${req.params.id}`);
});

// ---- Admin: renew agent（续费一个周期）----
router.post('/agents/:id/renew', adminOnly, (req, res) => {
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  // billing_cycle=0 表示白嫖/免费（无计费周期），须显式保留 0，不能用 || 30 吞掉。
  const cycle = (a.billing_cycle === undefined || a.billing_cycle === null || isNaN(Number(a.billing_cycle))) ? 30 : Number(a.billing_cycle);
  const base = (a.expire_at && new Date(a.expire_at + 'T00:00:00') > new Date())
    ? new Date(a.expire_at + 'T00:00:00') : new Date();
  // cycle<=0（白嫖）续费不改变到期日（保持当前/今天），仅刷新为今天以标识「已确认」。
  const next = new Date(base.getTime() + Math.max(0, cycle) * 86400000);
  const newExpire = next.toISOString().slice(0, 10);
  db.updateAgent(a.id, Object.assign({}, a, { expire_at: newExpire }));
  res.json({ ok: true, expire_at: newExpire });
  auditLog(req, 'renew_agent', `id=${a.id} expire_at=${newExpire}`);
});

// ---- Admin: 生成某受控端的「安装命令」与「修改探测目标命令」----
// 修改命令无需 Token（仅改本地 systemd drop-in / bat 后重启），可由管理员按需生成。
// query.probe_targets 可临时覆盖（用于预览不同 DNS 的命令），缺省用该受控端已存值。
router.get('/agents/:id/commands', adminOnly, (req, res) => {
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const probeTargets = str(req.query.probe_targets, 600) || a.probe_targets || '';
  const install = buildInstallCommands(getPublicBaseUrl(req), a.id, '<token>', AGENT_INTERVAL_DEFAULT, probeTargets);
  const modify = buildModifyCommands(getPublicBaseUrl(req), a.id, probeTargets);
  res.json({ id: a.id, probe_targets: probeTargets, install, modify });
});

// ---- Admin: UI + 通知设置（持久化到 admin_config）----
// GET 返回当前设置；密码类字段脱敏（留空表示「保持不变」）。
router.get('/settings', adminOrReadonly, (req, res) => {
  const notify = db.getNotifyConfig();
  const safe = Object.assign({}, notify);
  if (safe.smtp_pass) safe.smtp_pass = '';
  if (safe.telegram_bot_token) safe.telegram_bot_token = '';
  res.json({ ui: db.getUiSettings(), notify: safe });
});
router.put('/settings', adminOnly, (req, res) => {
  const b = req.body || {};
  if (b.ui && typeof b.ui === 'object') {
    // M-1：自定义 CSS 在落库前清洗，杜绝 @import/url()/外链字体/脚本注入。
    if (typeof b.ui.custom_css === 'string') b.ui.custom_css = sanitizeCss(b.ui.custom_css);
    db.setUiSettings(b.ui);
  }
  if (b.notify && typeof b.notify === 'object') db.setNotifyConfig(b.notify);
  res.json({ ok: true });
  auditLog(req, 'update_settings', b.ui ? 'ui updated' : '' + (b.notify ? ' notify updated' : ''));
});


// ---- Admin: send a test alert to verify notify channels (email / Telegram) ----
router.post('/test-alert', adminOnly, async (req, res) => {
  const st = alerts.notifyStatus();
  if (!st.mail && !st.telegram) {
    return res.status(400).json({ error: '未配置任何通知通道（SMTP 或 TELEGRAM）', status: st });
  }
  try {
    await alerts.sendAlert('[监控] 测试告警', '这是一条测试消息，用于验证通知通道（邮件 / Telegram）是否配置正确。若你收到了，说明配置生效。');
    res.json({ ok: true, message: '测试告警已发送，请检查邮件 / Telegram。', status: st });
  } catch (e) {
    res.status(500).json({ error: e.message, status: st });
  }
});

// ---- Admin: AI 运维分析 ----
// 配置读写、手动触发、报告列表/详情、运行状态。全部受 admin 鉴权保护。
// ai 模块默认关闭（getAiConfig().enabled === false），不影响现有功能。
const ai = require('./ai');
// GET 配置：api_key 脱敏（留空表示「已配置但本次不回显」，同 smtp_pass 处理，api.js:520）
router.get('/ai/config', adminOrReadonly, (req, res) => {
  const c = db.getAiConfig();
  const safe = Object.assign({}, c);
  if (safe.api_key) safe.api_key = '';
  // 补充一个 has_key 标志，让前端知道密钥是否已配置（不泄露密钥本身）
  safe.has_key = !!c.api_key;
  res.json({ config: safe });
});
// PUT 配置：api_key 留空保持不变（同 setNotifyConfig 模式，db.js setAiConfig 内部处理）
router.put('/ai/config', adminOnly, (req, res) => {
  const b = (req.body && req.body.config) || {};
  const allowed = {};
  // 白名单字段，避免前端塞入未预期字段
  if (typeof b.enabled === 'boolean') allowed.enabled = b.enabled;
  if (typeof b.provider === 'string') allowed.provider = b.provider.slice(0, 40);
  if (typeof b.base_url === 'string') allowed.base_url = b.base_url.slice(0, 200);
  if (typeof b.model === 'string') allowed.model = b.model.slice(0, 80);
  if (typeof b.api_key === 'string') allowed.api_key = b.api_key.slice(0, 200);
  if (typeof b.schedule_freq === 'string' && ['daily', 'weekly'].includes(b.schedule_freq)) allowed.schedule_freq = b.schedule_freq;
  if (typeof b.schedule_time === 'string' && /^\d{1,2}:\d{2}$/.test(b.schedule_time)) allowed.schedule_time = b.schedule_time;
  if (typeof b.tz_offset_hours === 'number' && Number.isFinite(b.tz_offset_hours)) allowed.tz_offset_hours = Math.max(-12, Math.min(14, b.tz_offset_hours));
  if (typeof b.batch_mode === 'boolean') allowed.batch_mode = b.batch_mode;
  if (typeof b.locale === 'string' && ['zh-CN', 'en'].includes(b.locale)) allowed.locale = b.locale;
  if (typeof b.log_retention_days === 'number' && Number.isFinite(b.log_retention_days)) allowed.log_retention_days = Math.max(7, Math.min(3650, Math.floor(b.log_retention_days)));
  // 启用时校验：必须有 model；api_key 要么本次传入非空，要么之前已配置
  if (allowed.enabled) {
    const hasKey = !!allowed.api_key || !!db.getAiConfig().api_key;
    const hasModel = !!allowed.model || !!db.getAiConfig().model;
    if (!hasModel) return res.status(400).json({ error: '启用 AI 分析需先配置模型名称（model）' });
    if (!hasKey) return res.status(400).json({ error: '启用 AI 分析需先配置 API Key' });
  }
  db.setAiConfig(allowed);
  res.json({ ok: true });
  auditLog(req, 'update_ai_config', allowed.enabled != null ? `enabled=${allowed.enabled}` : '');
});
// 手动触发一次日报生成（不等调度时刻）。返回生成结果。
router.post('/ai/run', adminOnly, async (req, res) => {
  try {
    const r = await ai.runNow();
    res.json(r);
    auditLog(req, 'ai_run', '');
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});
// 运行状态（前端展示 last_run / last_status）
router.get('/ai/status', adminOrReadonly, (req, res) => {
  res.json(ai.getStatus());
});
// 报告列表（分页）
router.get('/ai/reports', adminOrReadonly, (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const list = db.listAiReports(limit, offset);
  res.json({ total: db.countAiReports(), limit, offset, list });
});
// 单条报告详情（含 report_json，供前端渲染完整分析）
router.get('/ai/reports/:id', adminOrReadonly, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const r = db.getAiReport(id);
  if (!r) return res.status(404).json({ error: 'not found' });
  let parsed = null;
  try { parsed = JSON.parse(r.report_json); } catch (e) {}
  res.json(Object.assign({}, r, { report_json_parsed: parsed }));
});


// 登录后前端不再持有明文 Admin Token，凭证以 HttpOnly+Secure Cookie 维持，降低 XSS 窃取风险。
router.post('/login', loginRateLimit, async (req, res) => {
  if (!requireProto(req, res)) return; // F2：与管理端点一致，强制经 HTTPS 反代，杜绝明文 Token
  const { token, totp: code } = req.body || {};
  if (!token || !safeEqual(token, getAdminToken())) {
    return res.status(401).json({ error: 'invalid token' });
  }
  const need = db.is2FAEnabled();
  if (need) {
    const secret = db.get2FASecret();
    if (!code || !secret || !totp.verifyTOTP(secret, code)) {
      return res.status(401).json({ error: 'invalid totp', need_totp: true });
    }
  }
  const payload = { role: 'admin', totp: need, exp: Date.now() + SESSION_TTL };
  setSessionCookie(res, payload);
  res.json({ ok: true, totp: need });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---- Admin 2FA (TOTP) 管理 ----
router.get('/admin/2fa/status', adminOrReadonly, (req, res) => {
  res.json({ enabled: db.is2FAEnabled() });
});

// 生成密钥（尚未启用）。仅 admin 可调用；返回明文密钥仅此一次，供手动录入 Authenticator。
router.post('/admin/2fa/setup', requireAdmin, (req, res) => {
  if (db.is2FAEnabled()) return res.status(400).json({ error: '2fa already enabled' });
  const secret = totp.generateSecret();
  db.set2FASecret(secret);
  res.json({ secret, otpauth_uri: totp.otpauthUri(secret), enabled: false });
});

router.post('/admin/2fa/enable', requireAdmin, (req, res) => {
  const { code } = req.body || {};
  const secret = db.get2FASecret();
  if (!secret) return res.status(400).json({ error: 'run setup first' });
  if (!code || !totp.verifyTOTP(secret, code)) return res.status(400).json({ error: 'invalid code' });
  db.set2FAEnabled(true);
  res.json({ ok: true, enabled: true });
  auditLog(req, '2fa_enable', '');
});

router.post('/admin/2fa/disable', requireAdmin, (req, res) => {
  const { code } = req.body || {};
  if (!db.is2FAEnabled()) return res.status(400).json({ error: '2fa not enabled' });
  const secret = db.get2FASecret();
  if (!code || !secret || !totp.verifyTOTP(secret, code)) return res.status(400).json({ error: 'invalid code' });
  db.set2FAEnabled(false);
  res.json({ ok: true, enabled: false });
  auditLog(req, '2fa_disable', '');
});

// ---- Admin: 审计日志查询 ----
router.get('/admin/audit-logs', adminOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const logs = db.getAuditLogs(limit, offset);
  const total = db.countAudit();
  res.json({ logs, total, limit, offset });
});

module.exports = router;
