<h1 align="center">
  <img src="server/public/logo.svg" width="80" alt="Diting Logo">
  <br>谛听 · Diting
</h1>

<p align="center">
  <strong>自托管 Docker 监控 · 受控端零入站 · 无指令通道</strong><br>
  <a href="README_EN.md">English</a> · <a href="docs/src/content/docs/install.md">文档</a> · <a href="https://github.com/fengzone85/diting/issues">反馈</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/fengzone85/diting?style=flat-square&color=4ea5d9" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="license">
  <img src="https://img.shields.io/github/actions/workflow/status/fengzone85/diting/test.yml?branch=master&label=tests&style=flat-square" alt="tests">
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=node.js" alt="node">
  <img src="https://img.shields.io/badge/SQLite-3-003b57?style=flat-square&logo=sqlite" alt="sqlite">
  <img src="https://img.shields.io/badge/Python-3.8+-3776AB?style=flat-square&logo=python" alt="python">
  <img src="https://img.shields.io/badge/Linux-Docker-2496ED?style=flat-square&logo=docker" alt="linux">
  <img src="https://img.shields.io/badge/Windows-原生-0078D4?style=flat-square&logo=windows" alt="windows">
</p>

---

## ✨ 核心特性

<table>
<tr>
<td width="50%">

### 🔒 安全优先
- **受控端零入站** — 不监听任何端口，NAT/内网无影响
- **无指令通道** — Agent → Server 单向数据流，服务端无法控制 Agent
- **恒定时间 Token 比较** — 防时序侧信道
- **严格 CSP** — 无 `unsafe-inline`、无外链脚本
- **TOTP 两步验证** — 危险操作需动态码
- **IP 白名单** — 支持 IPv4/IPv6/CIDR</td>

<td width="50%">

### 📊 监控与告警
- **实时指标** — CPU/内存/硬盘/负载/流量/温度/Swap
- **月流量累计** — 持久化，重启不丢
- **网络质量探测** — 到固定公共 DNS 的延迟（着色：绿/黄/红）
- **告警通知** — QQ 邮箱 + Telegram 并行，带冷却去重
- **Prometheus `/metrics`** — Grafana 友好
- **到期倒计时** — <7天变黄、已过期变红</td>
</tr>
<tr>
<td width="50%">

### 🌐 轻量跨平台
- **Linux（Docker）** — 纯 Python 标准库，65-150MB
- **Windows（原生）** — psutil，登录自启计划任务
- **Agent 零耦合** — 彼此不知互存在
- **数据最小化** — 不采内核/GPU/公网IP/连接数
- **多盘支持** — 自动识别物理磁盘（过滤 tmpfs/proc）</td>

<td width="50%">

### ⚡ 一键部署
- **统一 diting.sh** — 服务端 + 受控端 + 更新 + 卸载 + 数据库管理
- **自动依赖安装** — Docker / git / curl 自动补齐
- **交互式菜单** — 引导式配置，中英文双语
- **自助注册** — SETUP_TOKEN 一键建客户端
- **数据库管理** — 备份/恢复/统计（`--backup` / `--restore` / `--db-stats`）</td>
</tr>
</table>

---

## 🚀 快速开始

```bash
# 一条命令完成部署
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/diting.sh -o diting.sh
chmod +x diting.sh
sudo ./diting.sh
```

> 脚本会自动安装 Docker、git 等依赖，引导你完成服务端和受控端的配置。

**非交互模式（CI / 批量）：**
```bash
# 安装服务端
sudo bash diting.sh --install-server

# 安装受控端（手动模式）
sudo bash diting.sh --install-agent --server https://your-server:8008 --id NODE1 --token SECRET

# 安装受控端（自助注册）
sudo bash diting.sh --install-agent --server https://your-server:8008 --setup-token <SETUP_TOKEN>
```

---

## 🏗️ 架构

```
[受控VPS-A] docker agent ──HTTPS+Token──┐
[受控VPS-B] docker agent ──HTTPS+Token──┼──> [专用VPS: server + dashboard]
[受控VPS-N] docker agent ──HTTPS+Token──┘      (Node + SQLite + ECharts / Nginx+TLS)
```

**关键设计：**
- Agent 仅出站 POST 到 `/api/report`，响应仅用于错误日志，**从不执行**
- 服务端绑定 `localhost:8081`，由 Nginx + TLS 反代对外暴露 443
- 数据库存储 Token 哈希（SHA-256），非明文
- 登录态用签名 `HttpOnly + Secure + SameSite=Strict` Cookie

---

## 📁 项目结构

```
diting/
├── diting.sh              # 一键部署/更新/卸载/数据库管理
├── docker-compose.yml      # 快速启动（测试用）
├── server/                 # 服务端（Node.js + Express + SQLite）
│   ├── server.js           # 入口 + 路由 + WebSocket
│   ├── src/
│   │   ├── api.js          # REST API（客户端/设置/告警）
│   │   ├── auth.js         # 鉴权 + Session + IP 白名单
│   │   ├── db.js           # SQLite + 迁移 + 配置
│   │   ├── alerts.js       # 阈值检查 + 邮件/Telegram 通知
│   │   ├── totp.js         # RFC 6238 TOTP（零依赖）
│   │   ├── validate.js     # 输入校验 + CSS 清洗
│   │   └── komari.js       # Komari 兼容 API 层
│   ├── public/             # 前端（仪表盘 + 公开页 + i18n）
│   └── test/security.test.js  # 安全单元测试
├── agent/                  # 受控端
│   ├── agent.py / collector.py  # Linux（Docker，纯标准库）
│   ├── windows/            # Windows 原生（psutil）
│   └── diting.sh          # 受控端独立安装脚本
├── docs/                   # 用户技术文档（14 篇）
└── nginx/monitor.conf.example  # TLS 反代 + 限流示例
```

---

## ⚙️ 环境变量

### 服务端（`.env`）

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `8081` | HTTP 监听端口 |
| `ADMIN_TOKEN` | 首次 | — | 管理员 Token（≥16 位） |
| `SETUP_TOKEN` | 否 | — | 受控端自助注册令牌 |
| `SESSION_SECRET` | 推荐 | 随机 | Session 签名密钥（固定则重启不失效） |
| `DB_PATH` | 否 | `/data/monitor.db` | SQLite 路径 |
| `RETENTION_DAYS` | 否 | `30` | 指标保留天数（7-3650） |
| `OFFLINE_THRESHOLD_SEC` | 否 | `60` | 离线判定阈值（秒） |
| `ALERT_CPU_PCT` | 否 | `90` | CPU 告警阈值（%） |
| `ALERT_MEM_PCT` | 否 | `90` | 内存告警阈值（%） |
| `ALERT_COOLDOWN_SEC` | 否 | `1800` | 告警冷却时间（秒） |
| `SMTP_HOST` | 否 | `smtp.qq.com` | SMTP 服务器 |
| `SMTP_PORT` | 否 | `465` | SMTP 端口 |
| `SMTP_USER` | 否 | — | SMTP 用户名 |
| `SMTP_PASS` | 否 | — | SMTP 密码（QQ 邮箱用授权码） |
| `ALERT_TO` | 否 | — | 告警收件人 |
| `TELEGRAM_BOT_TOKEN` | 否 | — | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | 否 | — | Telegram Chat ID |
| `READONLY_TOKEN` | 否 | — | 只读 Token（仅查看，不可写） |
| `ADMIN_ALLOW_HTTP` | 否 | — | 设为 `1` 允许 HTTP（仅内网测试） |

### 受控端

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `SERVER_URL` | ✅ | — | 服务端 URL（必须 HTTPS） |
| `AGENT_ID` | ✅ | — | 节点标识 |
| `AGENT_TOKEN` | ✅ | — | 认证令牌 |
| `INTERVAL` | 否 | `15` | 上报间隔（秒） |
| `DISK_PATH` | 否 | `/` | 磁盘统计路径 |
| `PROBE_TARGETS` | 否 | 移动/电信/联通 DNS + 8.8.8.8 | 网络质量探测目标（`label:host[:port]`，逗号分隔） |

---

## 📊 仪表盘功能

- **概览**：总数 / 在线 / 离线 / 平均 CPU·内存 / 流量概览 / 分组概览
- **客户端卡片**：状态点 / 国旗 / 商家徽章 / CPU/内存/负载/温度/Swap 迷你 sparkline / 硬盘进度条 / 到期倒计时 / 网络质量探测
- **详情页**：CPU/内存/负载/网络速率/硬盘/温度/Swap/网络质量/本月流量 ECharts 时序图（1h/6h/24h/7d）
- **客户端列表**：表格视图，点击行展开详情
- **拖拽排序**：管理员可自定义卡片顺序
- **分组显示**：按分组归类，顺序可配置

---

## 🔔 告警

- **离线告警**：超过 `OFFLINE_THRESHOLD_SEC` 未上报
- **阈值告警**：CPU/内存超过设定值
- **通知通道**：QQ 邮箱（SMTP）+ Telegram Bot（并行，任一失败不影响另一通道）
- **冷却去重**：默认 30 分钟内不重复发送同类告警
- **数据清理告警**：`prune` 连续 3 次失败时发送邮件
- **测试按钮**：后台「📨 测试告警」或 API `POST /api/test-alert`

---

## 🔑 只读账号（READONLY_TOKEN）

为降低「全权限 Admin Token 被到处共享」的风险，可配置一个**仅只读**的账号：

- 在 `.env` 设置可选的 `READONLY_TOKEN`（长度建议 ≥ 16）
- 持有者**仅能调用只读 GET 接口**（查看客户端列表、最新指标、sparkline、`/metrics`）
- 所有写操作（增删改客户端、重置 Token、测试告警）被 `adminOnly` 守卫拦截，返回 401
- 适用于 Grafana / 第三方看板等只读消费场景

---

## 📈 Prometheus 指标导出（`/metrics`）

- `GET /metrics` 返回 Prometheus 文本格式
- 鉴权：`Authorization: Bearer <ADMIN_TOKEN | READONLY_TOKEN>`
- 指标：`monitor_agent_cpu_percent`、`monitor_agent_mem_percent`、`monitor_agent_disk_percent`、`monitor_agent_net_rx_rate_bytes` 等
- 示例：`curl -H 'Authorization: Bearer TOKEN' http://localhost:8081/metrics`

---

## 🖥️ Windows 受控端

- 基于 `psutil`，采集 CPU/内存/磁盘/网络/开机时长
- 上报字段与 Linux Agent 完全一致，服务端零改动
- 安装：运行 `agent/windows/install.ps1` 自动安装依赖并注册计划任务
- Windows 无 load average，`load1/load5/load15` 固定占位 `0.0`

---

## 🛡️ 安全加固清单

- [ ] 通过 Nginx + TLS 反代，源站 8081 仅绑 `127.0.0.1`
- [ ] 设置强随机 `ADMIN_TOKEN`（≥16 位）
- [ ] 设置 `SESSION_SECRET`（固定随机值，防重启失效）
- [ ] 启用 TOTP 两步验证（设置 → 账户安全）
- [ ] 配置 IP 白名单（支持 IPv4/IPv6/CIDR）
- [ ] 定期备份数据库（`sudo bash diting.sh --backup`）
- [ ] 配置告警通知（邮件 / Telegram）
- [ ] 使用 Cloudflare Tunnel 或 Tailscale 隐藏源站 IP（可选）

---

## 🔄 更新

```bash
# 更新安装脚本自身
sudo bash diting.sh --update-script

# 更新服务端（git pull + 重建容器）
sudo bash diting.sh --update-server

# 更新受控端（保留已注册身份）
sudo bash diting.sh --update-agent
```

---

## 📖 文档

| 文档 | 说明 |
|------|------|
| [安装指南](docs/src/content/docs/install.md) | 各平台安装方式 |
| [快速开始](docs/src/content/docs/quick-start.md) | 5 分钟部署 |
| [服务端配置](docs/src/content/docs/server.md) | 环境变量与部署 |
| [受控端部署](docs/src/content/docs/agent.md) | Linux / Windows |
| [原生 Linux 部署](docs/src/content/docs/native.md) | systemd 方式 |
| [Windows 代理](docs/src/content/docs/windows.md) | Windows 原生 |
| [API 参考](docs/src/content/docs/api.md) | REST API 端点 |
| [环境变量](docs/src/content/docs/env.md) | 完整变量参考 |
| [安全设计](docs/src/content/docs/security.md) | 安全特性与加固 |
| [隧道指南](docs/src/content/docs/tunnel-guide.md) | Cloudflare Tunnel / Tailscale |
| [常见问题](docs/src/content/docs/faq.md) | FAQ |

---

## 🛡️ 安全设计原则

> **信任隔离比功能丰富更重要。** 安全不是靠叠加防护层，而是靠「不做什么」。

1. **无指令通道** — Agent 不接受任何服务端指令，只上报
2. **Agent 零耦合** — 一个 Agent 被攻破不影响其他
3. **数据最小化** — 只采基础状态，不采指纹信息（内核/GPU/公网IP）
4. **纵深防御** — HTTPS + Token 哈希 + 签名 Cookie + TOTP + IP 白名单
5. **服务端不可信** — 任一方失陷不波及另一方

---

## 威胁模型：信任边界分析（设计理念）

> 一句话：**信任隔离比功能丰富更重要。** 本项目的安全不是靠叠加防护层，而是靠「不做什么」——无指令通道、无主机指纹、无 Agent 互感知。攻击者无法利用根本不存在的东西。

### 我们的假设：服务端不可信，受控端也不可信

许多监控系统隐式假设「服务端是可信的」。一旦服务端失陷，所有受控端跟着沦陷——因为受控端接受服务端指令、执行下推任务、信任服务端说的一切。

本项目的设计假设相反：**服务端可能失陷、单个受控端可能失陷，且任一失陷都不能波及另一方。** 下面用代码逐条验证这一假设。

### 三大支柱（均经代码核实）

**① 无指令通道（Agent → Server 单向）**
- Agent 只 `POST` 到 `/api/report`，响应体仅用于错误日志（`e.read()`），**从不解析、从不执行**。Agent 不监听任何端口，没有 `subprocess`/`Popen`/`eval`/`exec`。
- 服务端唯一面向 Agent 的端点是 `POST /report`；`agentAuth` 只校验 Token 并存储指标，返回 `{ok:true}`。代码库里没有任何 WebSocket / SSE / 任何下行推送；仪表盘靠浏览器轮询刷新，与 Agent 无关。
- 这是**刻意不实现**指令通道，而非「还没做」。双向 WebSocket 监控正好相反：更强，但信任边界已破。

**② Agent 之间零耦合**
- 每个 Agent 只知自身 `SERVER_URL` + Token，彼此不知存在。
- 指标按 `agent_id` 分表存储；所有跨 Agent 聚合（`getAgents`/`getMetricsAll`）都是仅管理员可读的查询，用于仪表盘，从不下推给任何 Agent。即便服务端失陷，也没有任何机制让「Agent A 去联系 Agent B」。

**③ 采集数据不含可利用信息**
- 只采集基础状态：在线、负载、CPU、内存、磁盘、流量（含月累计）、温度、Swap、开机时长。温度/Swap/开机时长是**非指纹**指标（无内核版本/CVE 定向、无公网IP、无 GPU），即便泄露也无 actionable 价值。
- 我们**不采**内核版本、GPU、公网IP、连接数、进程数——这些可被用于定向攻击的指纹。即便服务端 DB 被拖库，泄露的也只是「机器 X 在 Z 时刻 CPU/内存为 Y」——对定向攻击毫无用处（无内核版本→无法 CVE 定向，无公网IP→无直接目标，无 GPU→无挖矿杠杆）。

### 三种失陷场景

| 场景 | 攻击者能 | 本项目 | 指令通道/指纹型监控 |
| --- | --- | --- | --- |
| ① 服务端失陷 | 读取已上报数据 | ✅（基础状态含非指纹指标，无指纹） | ✅（含内核/GPU/公网IP/连接数） |
| | 伪造数据误导 Agent | 无影响（Agent 不接指令） | 无影响 |
| | 下推恶意任务/探测 | ❌ 不可能（无指令通道） | ✅ 可下推；Agent 变跳板 |
| | 横向移动至其它 Agent | ❌ 不可能 | ⚠️ 可经任务探测其它网络 |
| ② 单 Agent 失陷 | 读取自身 Token | ✅（docker env 可见） | ✅（ps/cmdline 可见） |
| | 伪造自身数据 | ✅（仅影响自身） | ✅ |
| | 横向移动/攻击服务端 | ❌ 不可能（仅 POST；服务端不跑 Agent 命令） | ❌ 不可能 |
| ③ 服务端+单 Agent 失陷 | 获取其它 Agent Token | ⚠️ 能（见下） | ⚠️ 能 |
| | 伪造其它 Agent 数据 | ⚠️ 能 | ⚠️ 能 |
| | 在其它 Agent 上执行/下推任务 | ❌ 不可能（无指令通道） | ✅ 可能（探测任务，非 RCE） |

### 场景 ③ 的补充（我们的设计更乐观）

Token 在数据库中以 **SHA-256 哈希**（`token_hash`）存储，从不明文。鉴权时比对 `sha256(提交Token)` 与存储哈希（恒定时间）。因此：
- **只读** DB 泄露（如被拖库但无写入权限）不会泄露任何 Agent 的明文 Token。要伪造其它 Agent 数据，攻击者要么暴力破解 24 字节随机 Token（不可行），要么把 `token_hash` 覆写为已知值。
- 换言之，仅「服务端失陷」且只读时**无法立即伪造**；需要 DB 写入权限。这是对上表 ⚠️ 行的具体加固。

最坏情况下（服务端 + 单 Agent 均失陷），攻击者的天花板只是**伪造其它 Agent 的上报**——仪表盘显示假数据，但**没有任何一台机器被控制**。

### 两个诚实的说明
1. **关于采集集合**：除基础状态外，我们还存了 `hostname`、`os`（发行版名，如 "Ubuntu 22.04"）、温度、Swap、开机时长。它们是轻量标识或**非指纹指标**（温度/Swap/开机时长不含内核版本/CVE 定向、无公网IP、无 GPU），并非攻击指纹；「无指纹」应理解为「无可被用于定向攻击的指纹」。
2. **Token 哈希把「明文泄露」降级为「需 DB 写入权限才能伪造」**，并非完全免疫——评估场景 ③ 时应明确这点。

---

## 与主流监控的信任边界对照（以 Nezha 为例）

许多监控（如 Nezha）以**被控机暴露公网 + 双向通信（WebSocket）+ 远程执行**的架构优先功能。更强，但信任边界已破：一旦服务端失陷，每台被控机都变成可被远程操控的节点。

| 维度 | DiTing（本项目） | 指令通道型监控（如 Nezha） |
| --- | --- | --- |
| 受控端入站 | 零入站（仅出站 HTTPS） | 通常暴露端口/面板到公网 |
| 通信方向 | 单向（Agent→Server POST） | 双向（WebSocket，服务端可下推） |
| 远程执行 | ❌ 无（刻意不做） | ✅ 有（命令执行→RCE 风险） |
| Agent 耦合 | 零；互不知晓 | 服务端可编排；Agent 可互连 |
| 采集内容 | 基础状态（含温度/Swap/开机等非指纹指标），无指纹 | 可能含内核/版本/网络细节 |
| 最坏情况（服务端+1 Agent 失陷） | 仅上报伪造；无机器被控 | 可下推任务探测/执行 |
| 信任模型 | 服务端和 Agent 均不可信 | 隐式假设「服务端可信」 |

> 一句话：DiTing 用「功能减法」（无指令通道、无指纹、Agent 互不感知）换取「安全加法」。攻击者无法利用根本不存在的东西。

---

## 关于其它 agent 类探针的澄清（源码级证据）

某些常与本项目对比的 agent 类探针（某开源项目，采用服务端→Agent 指令通道）也用该模式。这里用其真实的 `agent/main.go` 源码澄清两个常见误解。

**误解 1：「该 Agent 可被 RCE」——错误。**
其 ICMP 探测路径为：`executeICMPPing(target)` → `resolvePublicIPs()`（DNS 解析 + 黑名单检查）→ 取 `ips[0].String()` → 才 `exec.Command("ping", "-c", "1", "-W", "2", pingTarget)`。关键两点：
- 到达 `exec.Command` 的参数**永远只是 `net.IP.String()` 的输出**（如 `192.168.1.1`、`2001:db8::1`）——绝不可能含 `;`、`|`、反引号等 shell 元字符。
- Go 的 `exec.Command` 直接调用 `execve`，不涉及 `/bin/sh`。

所以即便服务端下推 `; rm -rf /`，也会在 `resolvePublicIPs` / `net.ParseIP` 阶段被拒绝，ping 根本不会启动。**这不是 RCE，而是类型受限的命令调用。** 把它等同于「存在 exec 调用=可任意执行代码」是典型的审计过度泛化。其 TCP/HTTP 路径用已校验的 `net.IP` 对象直接 `dial`（无二次 DNS 解析），无 DNS 重绑定 / TOCTOU 绕过——其 SSRF 防御其实相当严格。

**误解 2：「给 WebSocket 任务加签名就能修复服务端失陷风险」——对本威胁模型无效。**
本项目的威胁模型假设服务端不可信且可能失陷。服务端一旦失陷，攻击者持有签名私钥，**就是合法的签名方**。任务签名只能防传输中被第三方篡改，无法阻止服务端本身就是攻击者。要让签名在此生效，需要服务端之外的信任根（独立 CA 或 Agent 本地白名单）——那本质上就是重设信任模型，而那正是「无指令通道」本身。

**正确定性 & 结论：**
- 服务端失陷后，攻击者**能**让所有 Agent 经 ICMP/TCP/HTTP 探测任意公网目标（受 CIDR 黑名单限制仅限公网地址，触不到内网）。它是**分布式探测跳板**，而非 RCE 僵尸网络。
- 但「探测跳板」能力**不是 bug，而是核心功能**（公网 ping 监控）。保留该功能就无法移除它；唯有消除指令通道（本项目做法）才能彻底解决。

> 一句话：这类 agent 类探针是*受约束的受控探测 Agent*，不是 *RCE 后门*。它的问题不在 RCE——而在「指令通道」这一存在的本身，而本项目刻意回避它。

---

## 为什么我们刻意不实现这些功能

核心理念是「靠不做来提升安全」。以下是同类监控常见、我们刻意省略的功能，每条都附安全理由。每条省略都对应我们某条信任边界保证。

### 1. 集中式主动探测（对任意目标的 ICMP/TCP/HTTP ping，可指派到特定节点）
要让 Agent ping/探测某目标，服务端必须向它下推任务——这需要指令通道。一旦指令通道存在，信任边界即破：失陷的服务端可让每个 Agent 探测任意公网目标，把机群变成分布式探测跳板。我们严格保持 Agent→Server 单向，因此不提供「服务端编排探测」。

> **补注（2026-07-09）：我们加了一个安全的等价物——「Agent 侧网络质量自测」。** 思路是用「Agent 自 ping / TCP 探测几个*写死在本地配置里的固定公共基础设施*（默认三家运营商 DNS + 8.8.8.8）」替代「服务端下推任意探测目标」。因为探测目标来自 Agent 本地配置、服务端**从不**下推任何目标，指令通道不存在，信任边界完好。见下方「网络质量自测（固定公共目标）」。它遵守「不做」原则：无指纹、无新指令通道、Agent 零耦合。

### 2. 主机指纹（内核版本 / GPU 型号 / 公网IP / TCP 连接数等）
此类指纹一旦服务端被拖库（尤其外泄），直接暴露每台机器的攻击面——老内核版本可被定向 CVE 匹配、公网IP 给直接目标、GPU 可用于挖矿权衡。我们只采基础状态（含温度/Swap/开机等非指纹指标），因此即便泄露也无定向攻击价值。

### 3. 服务端下推采样间隔 / 采集策略
这是指令通道的又一个变体（服务端影响 Agent 行为）。我们把采样逻辑在 Agent 本地固定；服务端既不推送也不感知，从而保持「任一方失陷都不波及另一方」的隔离。

### 4. 把 Agent 当跳板去探测第三方
以上各点的自然结果。无指令通道、无可被外部控制的命令调用，Agent 在任何情况下都不会被诱导去联系攻击者指定的目标。

> 注：仪表盘、指标历史图表、节点分组、基于现有指标的告警、带 TOTP 的多用户访问等均已完整提供——它们只读 Agent 已上报的基础状态数据，不依赖任何下行指令，因此不破坏上述任何保证。一句话：我们用「让服务端指挥 Agent 干活」的便利，换取「服务端或任何 Agent 失陷都不会扩散到另一方」的隔离。攻击者无法利用根本不存在的东西。

---

## 网络质量自测（固定公共目标）

Agent 从**自身主机**主动 ping / TCP 探测**写死在本地配置里的公共基础设施**（默认：联通/电信/移动 DNS + 8.8.8.8），把每个目标的往返延迟与可达性上报给服务端。它是我们拒绝实现的「集中式主动探测」功能的安全等价物：

- **目标本地写死**：经 `PROBE_TARGETS` 环境变量配置，格式 `label:host[:port]`，逗号分隔；默认即可用，置空则关闭。服务端**从不**向 Agent 下推任何探测目标——与指令通道型监控的根本分野。
- **无指令通道**：服务端无法命令任何 Agent 探测任意主机，因此机群永远不会变成分布式探测跳板。核心支柱（无指令通道 / Agent 零耦合 / 数据最小化）完整保留。
- **仅延迟与可达性**：每个目标只上报 `ms`（往返毫秒，不可达为 `null`）和 `ok`（布尔）——不含任何主机指纹。
- **ICMP 优先，TCP 兜底**：优先系统 `ping`（`-c 1`；经 `iputils-ping` 的 `cap_net_raw` 可非 root 工作）；若 `ping` 不可用或被拦，回退到对目标端口（默认 53）的 TCP 握手——即便无特权也可工作。目标并行探测，每个采集周期仅增加约 1–2 秒。
- **展示**：客户端卡片显示一行「网络」（如 `移动 18ms · 电信 23ms · 联通 ✕`）；详情页渲染多序列 ECharts 时序图「网络质量（到探测目标的延迟，ms）」。

> 注：该能力只测「本机 → 固定公网IP」的网络质量。它与「让服务端编排 Agent 探测任意目标」完全不同，后者仍是我们刻意不实现的功能（见上方「集中式主动探测」）。

> 实时速率（上下行）也是此类安全增强的典型：速率由 Agent 本地两次采样算出（`net_rx_rate`/`net_tx_rate`），经既有上报通道传输，由前端轮询展示——不新增指令通道、不采集指纹。本项目已在 Agent 详情视图提供实时速率读数，每 3 秒刷新。

---

## 🔍 与其它探针的对比：为什么不做远端动态配置 / 自更新

不少同类探针（含基于 Cloudflare Worker 的方案、以及 Nezha 等指令通道型监控）会让**服务端向受控端下发配置**，甚至支持**受控端自我更新**（从远端拉取安装脚本并以 root 执行）。这类能力本质是**指令通道**——也正是本项目刻意不做的地方。

### 远端动态配置 / 自动更新长什么样
- **热更新配置**：服务端在 HTTP 响应头返回 `X-Agent-Config-Md5`，响应体下发采集间隔、流量校正、探测目标等指令，Agent 校验后写盘并热加载，无需重启。
- **自更新**：开启 `AUTO_UPDATE` 后，Agent 从服务端推导出的地址拉取 `diting.sh` 并以 `bash -s install` 执行——即**以 root 在受控机上运行远端脚本**。

### 为什么我们不做
1. **信任边界崩溃**：一旦存在「服务端 → Agent」的下行通道，信任模型就从「服务端和 Agent 互不信任」退化为「隐式信任服务端」。服务端一旦失陷，攻击者即可向**每一台**受控端下发指令，把整个机群变成可被远程操控的节点（甚至分布式探测跳板）。
2. **代码执行面**：自更新 `bash -s install` 等价于把 root 执行权交给「远端脚本 + 脚本源」。若 `WORKER_URL`/CDN 被中间人或供应链投毒，受控端会直接以 root 跑任意脚本（RCE / 供应链攻击）。
3. **与「零指纹」原则一致**：动态下发的探测目标、采样策略同样属于「服务端影响 Agent 行为」的指令通道变体，我们一律拒绝。

我们的做法是**本地固定、单向上报**：
- 采样逻辑在 Agent 本地写死，服务端既不推送也不感知；
- 网络质量探测目标写死在本地 `PROBE_TARGETS`（`label:host[:port]`，默认三家运营商 DNS + 8.8.8.8），**服务端永远不下发任何探测目标**；
- 更新受控端必须**由运维在受控机本地执行**（`sudo bash diting.sh --update-agent`，保留已注册身份），而非 Agent 自己从远端拉脚本。

> 一句话：本项目用「功能减法」（无指令通道、无指纹、Agent 互不感知）换取「安全加法」。攻击者无法利用根本不存在的东西。需要更新时，请走本地运维通道，而非远端自更新。
>
> **供应链完整性（L-6）**：部署受控端时通过 `SP_AGENT_SHA256S` 环境变量钉死已知良好版本的 SHA-256 哈希，防止 GitHub CDN / 中间人投毒。不设则跳过校验。详见 [Agent 安全原则](agent/README.md#安全原则)。

> 补充：GPU 型号（`nvidia-smi` / `lspci` 取得的硬件标识）属于**主机指纹**，与本项目「不采内核/GPU/公网IP」原则冲突，因此**不做 GPU 监控**。

---

## 📄 许可证

[MIT](LICENSE)
