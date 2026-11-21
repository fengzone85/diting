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
const db = require('../db');
const { CURRENCIES, normalizeCurrency } = require('../billing');
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

// ---- 节点安装命令生成（api.js 与 routes/nodes.js 共用）----
// 计费周期口径：-1 = 一次性、0 = 免费、>0 = 天数（与 billing 汇总同源）。
const BILLING_CYCLES = [-1, 0, 30, 60, 90, 180, 365, 730, 1095];
// 接受 ISO 码（USD/CNY/JPY…）与历史符号（$ / ¥ / €…）；
// 汇总与汇率表内部统一归一化成 ISO（见 src/billing.js normalizeCurrency）。
const isValidCurrency = (c) => {
  const code = normalizeCurrency(c);
  return !!code && CURRENCIES.includes(code);
};
const isValidCycle = (n) => BILLING_CYCLES.includes(n);

// ---- 一键安装命令生成（参考面板风格：服务端把地址 + 每客户端令牌预填进命令）----
// 三条接入路径（2026-10 起全部为 Go 受控端，Python 版 agent/ 已下线）：
// ① 原生版（Linux systemd，diting.sh 自举下载 agent-go 载荷）；
// ② Docker 版（现场从源码 git 构建镜像并运行，无需任何仓库账号）；
// ③ Windows 版（PowerShell 一键：下载 install.ps1 → 自举拉取 agent-go 载荷 → 注册计划任务）。
// 仓库 raw 基址（diting.sh 位于根，受控端载荷位于 <base>/agent-go/）；可用 AGENT_RAW_REPO 覆盖。
const REPO_BASE = (process.env.AGENT_RAW_REPO || 'https://raw.githubusercontent.com/fengzone85/diting/master').replace(/\/+$/, '');
const AGENT_GIT_REPO = process.env.AGENT_GIT_REPO || 'https://github.com/fengzone85/diting.git#master:agent-go';
const AGENT_INTERVAL_DEFAULT = Number(process.env.AGENT_INTERVAL || 20);

// 受控端接入用的服务端公网地址：优先级为
// ① UI 设置中「Agent 连接地址」② UI 设置中「项目网址」③ 环境变量 PUBLIC_URL ④ 从请求头自动推导。
// 受控端接入用的服务端公网地址，优先级：
// ① UI 设置中「Agent 连接地址」② UI 设置中「项目网址」③ 环境变量 PUBLIC_URL。
// 未配置时返回 null（调用方必须中止业务流程），过去回退到 X-Forwarded-Host / Host 的兜底已被移除：
// 该头可被攻击者注入，使管理员复制到的安装命令内嵌 AGENT_TOKEN 却指向错误地址（纵深防御）。
// Breaking：未配置的实例调用安装命令相关端点会返回 400 server_url_not_configured。
function getPublicBaseUrl() {
  const ui = db.getUiSettings();
  if (ui && ui.agent_server_url) return ui.agent_server_url.replace(/\/+$/, '');
  if (ui && ui.site_url) return ui.site_url.replace(/\/+$/, '');
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return null;
}

// 统一的「未配置服务器地址」响应，避免三个调用点文案不一致。
function serverUrlUnconfigured(res) {
  return res.status(400).json({
    error: 'server_url_not_configured',
    message: '未配置服务器公网地址：请先在「设置 → Agent 连接地址」填写（或设置环境变量 PUBLIC_URL），然后重试。'
  });
}

// 参考面板风格：一条命令搞定对接。原生版走根 diting.sh（自动拉取 agent 载荷并装 systemd）；
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
// 探测目标归一化（真机根因见 buildModifyCommands 的注释）：
// 多行视作逗号分隔 → 合并连续逗号 → 去首尾逗号。安装与修改两条命令共用，
// 避免「安装时清洗、修改时不清洗」这种半修复。
function normalizeProbeTargets(v) {
  return String(v == null ? '' : v)
    .replace(/[\r\n]+/g, ',')
    .replace(/,{2,}/g, ',')
    .replace(/^,+|,+$/g, '')
    .trim();
}

function buildInstallCommands(serverUrl, agentId, agentToken, interval, probeTargets, monthRotate = 0) {
  probeTargets = normalizeProbeTargets(probeTargets);
  const iv = interval || AGENT_INTERVAL_DEFAULT;
  const mr = Number.isInteger(monthRotate) && monthRotate >= 0 && monthRotate <= 31 ? monthRotate : 0;
  const ptArg = probeTargets ? ` --probe-targets ${shQuote(probeTargets)}` : '';
  const ptEnv = probeTargets ? ` -e PROBE_TARGETS=${shQuote(probeTargets)}` : '';
  const ptWin = probeTargets ? ` -ProbeTargets ${psQuote(probeTargets)}` : '';
  // 原生版采用下载后执行风格：先下载成文件、chmod +x、再 sudo 执行（相对 curl|bash 更透明、可审阅）。
  const native = `curl -fsSL ${REPO_BASE}/diting.sh -o diting.sh
chmod +x diting.sh
sudo ./diting.sh --install-agent --repo ${REPO_BASE} --server ${shQuote(serverUrl)} --id ${shQuote(agentId)} --token ${shQuote(agentToken)} --interval ${iv} --month-rotate ${mr}${ptArg}`;
  // Docker 版（M3 起 Go scratch 镜像，~7.5MB）：--network host 取真实流量；
  // /:/host:ro 是宿主磁盘监控的结构性依赖（见 agent-go/docker-compose.yml 注释）；
  // cap_drop ALL + no-new-privileges（纯 TCP 探测无需 NET_RAW）。
  const docker = `docker build -t diting-agent ${AGENT_GIT_REPO} \\\n  && docker run -d --name diting-agent --restart unless-stopped \\\n     --network host --cap-drop ALL --security-opt no-new-privileges:true \\\n     -e SERVER_URL=${shQuote(serverUrl)} -e AGENT_ID=${shQuote(agentId)} -e AGENT_TOKEN=${shQuote(agentToken)} -e INTERVAL=${iv} -e MONTH_ROTATE=${mr} -e DISK_PATH=/host${ptEnv} \\\n     -v /:/host:ro \\\n     diting-agent`;
  // Windows 版（M3 起 Go 单二进制）：一条 PowerShell 命令。外层用双引号、内部一律
  // 单引号，避免引号嵌套。install-go.ps1 从 GitHub Release 下载 diting-agent.exe
  // （SHA256 校验）并注册计划任务（AtStartup/LocalService/自动重启/单实例互斥）。
  // 需以管理员身份运行。GO_RELEASE = agent-go Release 下载基址（latest）。
  const GO_RELEASE = 'https://github.com/fengzone85/diting/releases/latest/download';
  const windows = `powershell -NoProfile -ExecutionPolicy Bypass -Command "\`$p=Join-Path \`$env:TEMP 'diting-go-install.ps1'; iwr '${REPO_BASE}/agent-go/install-go.ps1' -OutFile \`$p -UseBasicParsing; & \`$p -RepoBase '${GO_RELEASE}' -ServerUrl ${psQuote(serverUrl)} -AgentId ${psQuote(agentId)} -AgentToken ${psQuote(agentToken)} -Interval ${iv} -MonthRotate ${mr}${ptWin}"`;
  // Docker 版（M3 起同为 Go）：多阶段构建出 scratch 镜像（USER 1000 + cap-drop ALL），
  // 多盘识别在 Go collector 内优先读 /hostproc/mounts、回退 /proc/mounts，无需额外挂 /proc。
  return { server_url: serverUrl, native_cmd: native, docker_cmd: docker, windows_cmd: windows, probe_targets: probeTargets || '', month_rotate: mr };
}

// 免 Token 的「修改探测目标」命令：已有受控端换 DNS 时，无需重装 / 无需 Token。
// Linux 写 systemd drop-in 并重启；Windows 改 run_scheduled.bat 的 PROBE_TARGETS 行后重启计划任务。
function buildModifyCommands(serverUrl, agentId, probeTargets) {
  // 探测目标必须是**单行**（逗号分隔列表）。
  // 真机教训（2026-10-26）：值里一旦带换行，写进 Windows 的 run_scheduled.bat 后
  // 那一行会与上一行合并 —— cmd 只把 CRLF 当行分隔，孤立的 LF 不分行，
  // 于是 `set PROBE_TARGETS=…` 成了 `set MONTH_ROTATE=…` 的值的一部分，从未生效。
  // 症状极隐蔽：面板显示已配置、bat 里也肉眼可见该行，但受控端始终报内置默认目标。
  const pt = normalizeProbeTargets(probeTargets);
  const linux = `sudo mkdir -p /etc/systemd/system/diting-agent.service.d
sudo tee /etc/systemd/system/diting-agent.service.d/probe.conf >/dev/null <<'EOF'
[Service]
Environment="PROBE_TARGETS=${pt}"
EOF
sudo systemctl daemon-reload
sudo systemctl restart diting-agent`;
  // 无 PROBE_TARGETS 行时插入到「启动行（exe）之前」——旧实现 Add-Content
  // 追到文件末尾（启动行之后），该 set 永远不会生效。Go 安装器保证该行存在，
  // 此处仅作存量/手改 bat 的兜底。
  // 写回时**显式**用 CRLF + UTF-8(no BOM) + `Get-Content -Encoding UTF8`：
  //   - Set-Content 在 PS 5.1 默认 ANSI，会把既有 UTF-8 中文二次编码（双编码），
  //     导致受控端上报的 label 变乱码；
  //   - 且它写出的行分隔符不受控，历史上正是这条路径把 LF 混进 bat。
  const win = `$id=${psQuote(agentId)}; $pt=${psQuote(pt)}
$bat=Join-Path $env:ProgramData "diting-agent\\run_scheduled.bat"
$nl=[string][char]13+[string][char]10
$lines=@(Get-Content -Encoding UTF8 $bat)
if ($lines -match '^set PROBE_TARGETS=') {
  $out=@($lines -replace '^set PROBE_TARGETS=.*', "set PROBE_TARGETS=$pt")
} else {
  $idx=[array]::FindIndex($lines, [Predicate[string]]{param($l) $l -match 'diting-agent(-windows-amd64)?\\.exe'})
  if ($idx -gt 0) { $out=@($lines[0..($idx-1)]) + @("set PROBE_TARGETS=$pt") + @($lines[$idx..($lines.Count-1)]) }
  elseif ($idx -eq 0) { $out=@("set PROBE_TARGETS=$pt") + @($lines) }
  else { $out=@($lines) + @("set PROBE_TARGETS=$pt") }
}
[IO.File]::WriteAllText($bat, (($out -join $nl) + $nl), (New-Object Text.UTF8Encoding($false)))
Stop-ScheduledTask -TaskName "HostMonitorAgent-$id"; Start-ScheduledTask -TaskName "HostMonitorAgent-$id"`;
  return { linux_cmd: linux, windows_cmd: win, probe_targets: pt };
}


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
  isValidCurrency,
  isValidCycle,
  AGENT_INTERVAL_DEFAULT,
  getPublicBaseUrl,
  serverUrlUnconfigured,
  buildInstallCommands,
  buildModifyCommands,
};
