---
title: 受控端部署
description: Agent 部署指南
---

# 受控端部署

DiTing 受控端支持三种部署形态，数据格式与上报契约完全相同，**全部基于 Go 实现**（`agent-go/`）。
Python 版受控端（原 `agent/` 目录）已于 2026-10 下线并从仓库移除，存量节点请重新以 Go 版接入。

## 形态对比

| | Docker (Go) | 原生 systemd (Go) | Go 二进制（源码构建） |
|---|---|---|---|
| 内存占用 | 65-150MB（含 Docker 守护进程） | <10MB | <10MB |
| 前置依赖 | Docker Engine | 无（零依赖静态二进制） | Go 工具链（仅构建期） |
| 安全隔离 | scratch + `USER 1000` + `--cap-drop ALL` + `no-new-privileges` + 只读挂载 | systemd 5 项加固（`NoNewPrivileges`/`ProtectSystem=strict`/`ProtectHome`/`PrivateTmp`/`ReadWritePaths`） | 同左（运行时由部署方决定） |
| 部署复杂度 | 一条命令 | 交互脚本 | 编译二进制 |
| 适用场景 | 已有 Docker 环境 | 精简系统 / 小内存 | 开发调试 / 自制部署 |
| 实现 | `agent-go/`（Dockerfile + docker-compose.yml） | `agent-go/install.sh` + `diting-agent.service` | `agent-go/`（直读 /proc，零依赖） |

## Docker 部署

后台「添加 Agent」生成的一键命令为**从源码构建 Go 镜像**（无需仓库账号，多阶段构建出 scratch 镜像，`USER 1000` + `--cap-drop ALL` + `no-new-privileges`）：

```bash
docker build -t diting-agent https://github.com/fengzone85/diting.git#master:agent-go && docker run -d --name diting-agent --restart unless-stopped --network host --cap-drop ALL --security-opt no-new-privileges:true -e SERVER_URL="https://monitor.example.com" -e AGENT_ID="<ID>" -e AGENT_TOKEN="<Token>" -e INTERVAL=20 -e DISK_PATH=/host -v /:/host:ro -v diting-state:/data diting-agent
```

也可使用随 `agent-go-v*` tag 发布到 ghcr 的镜像：

```bash
docker run -d \
  --name diting-agent \
  --restart unless-stopped \
  --network host --cap-drop ALL --security-opt no-new-privileges:true \
  -e AGENT_ID="<ID>" \
  -e AGENT_TOKEN="<Token>" \
  -e SERVER_URL="https://monitor.example.com" \
  -e DISK_PATH=/host \
  -v /:/host:ro \
  -v diting-state:/data \
  ghcr.io/fengzone85/diting-agent:latest
```

> `--network host` 让容器共享宿主网络命名空间，`/proc/net/dev` 才能反映真实流量；`-v /:/host:ro` + `DISK_PATH=/host` 让磁盘统计针对 VPS 真实根盘而非容器 overlay。
> 多盘识别优先读 `/hostproc/mounts`、回退 `/proc/mounts`，因此**不需要**额外挂 `/proc`。
> 纯 TCP 探测不需要 `NET_RAW`，`--cap-drop ALL` 可安全放下；镜像内以 uid 1000（用户 `diting`）运行。
> 镜像默认 `INTERVAL=15`，需要 20s 时显式 `-e INTERVAL=20`。

## 原生 systemd 部署（Go 版，推荐）

```bash
# 后台「添加 Agent」生成的一键命令（含服务端地址与凭据），或：
sudo bash diting.sh --install-agent --server https://your-server --id <id> --token <token>
```

脚本会（`agent-go/install.sh`）：
1. 从 GitHub Release 下载单二进制并用 **SHA256 强制校验**（`diting-agent-linux-amd64/arm64`）
2. `mkdir -p /opt/diting`（未额外 `chmod`）并安装 `/opt/diting/diting-agent`（755 root:root）
3. 生成 `/etc/diting/agent.env`（600，含 Token 和 Server URL；`PROBE_TARGETS` 可选），`/var/lib/diting` 收窄为 700 diting:diting
4. 注册 systemd 服务（只读系统加固 + 状态目录可写）
5. 启动并设置开机自启

> Python 版安装器（`agent/install.sh`）已随 `agent/` 目录一并下线；新装与 `--update-agent` 均只走 `agent-go/install.sh`。

### systemd 安全加固项

以下为 Go 版 unit（`agent-go/diting-agent.service`）的**实际**内容，共 5 项：

| 加固项 | 说明 |
|---|---|
| `NoNewPrivileges=true` | 禁止提权 |
| `ProtectSystem=strict` | 文件系统只读 |
| `ProtectHome=true` | /home 不可访问 |
| `ReadWritePaths=/var/lib/diting` | 仅放行状态目录可写（月流量累计） |
| `PrivateTmp=true` | 隔离 /tmp |

> Go 版为纯 TCP 探测，不需要 `CAP_NET_RAW`，因此未启用 `AmbientCapabilities` 之类的 ICMP 权限。
> 如需进一步收紧，可自行追加 `RestrictAddressFamilies`（注意用 `AF_` 前缀短名：`inet/inet6/unix`
> 仅在 systemd ≥ 254 可用，在更旧版本上会被静默忽略并丢弃整条限制）。

## Go 受控端（唯一受控端）

Go 受控端直读 `/proc`、零外部依赖、强制 HTTPS、单向上报、零入站端口、无指令通道；体积 ~5MB 静态二进制、内存 <10MB。

> **自 2026-10 起 Go 是唯一受控端**：`diting.sh --install-agent`、Windows 一键命令、
> Docker 一键命令（`docker build ...#master:agent-go`，Go scratch 镜像）均为 Go 版；
> 原 Python 实现（`agent/`）已从仓库移除。
> 以下为从源码构建（一般在开发时使用；生产部署走上面的安装脚本）。

### 构建

```bash
cd agent-go
CGO_ENABLED=0 go build -ldflags="-s -w" -o diting-agent-go .
# 版本号注入（可选）：go build -ldflags="-s -w -X main.version=1.0.0" .
```

### 运行

```bash
SERVER_URL=https://agent.example.com:4443 \
AGENT_ID=agt_xxxxxxxxxxxx \
AGENT_TOKEN=xxxxxxxxxxxx \
DISK_PATH=/ \
./diting-agent-go
```

> Go 版默认 `DISK_PATH=/`；容器内运行需配合 `-v /:/host:ro`（多盘识别优先读 `/hostproc/mounts`，回退 `/proc/mounts`）。

> **安全说明（容器挂载面，审查 B1）**：`-v /:/host:ro` 是宿主磁盘监控的架构依赖（`disk_list` 依赖 mount 命名空间中的 `/host` 前缀条目统计多盘），但它使 agent 进程可读宿主任一 uid≤1000 可读的文件。缓解：容器已 `cap_drop: ALL` + `no-new-privileges` + uid 1000 运行，agent 无指令通道、仅 `statvfs`/读 `/proc`，利用前提是 agent 自身被攻破（纵深防御缺口而非直接利用面）。如需进一步收窄：保留 `-v /proc:/hostproc:ro`，按 `/hostproc/mounts` 中的条目逐盘 bind（如 `-v /data:/host/data:ro`）并去掉 `/:/host:ro`——`disk_list` 在 `DISK_PATH=/host` 时优先读 `/hostproc/mounts`，各 `/host/...` 路径 bind 可达即可正常统计；**不要改用 `/proc/1/mounts`**（compose 无 `pid: host`，容器内 `/proc/1` 是容器自己的 init，读不到宿主挂载表）。

> **探测口径（审查 E7）**：受控端为纯 TCP 探测，`loss` 只有二值（握手成功 0 / 预算内全失败 100），不代表链路丢包率，请勿据此判断丢包比例。

> **告警阈值（审查 C-1/E2）**：`offline_sec`/`cpu_pct`/`mem_pct`/`disk_pct`/`temp_c` 按「节点覆盖 > 分组覆盖 > 后台显式设置 > 环境变量 > 默认」解析（S1/F1，覆盖表为空时行为与旧版一致），告警、看板、AI 摘要三端同源；`DISK_ALERT_PCT`（默认 90）与 `TEMP_ALERT_C`（默认 80）为磁盘/温度告警阈值。触发判定采用采样窗口：默认 `ALERT_WINDOW_SAMPLES=5` 内超限占比 ≥ `ALERT_TRIGGER_RATIO=0.7`；显式设置 `ALERT_SUSTAIN_SAMPLES=N` 退回旧的「连续 N 次全超限」。`ALERT_COOLDOWN_SEC`（默认 1800）为同类告警冷却，`ONLINE_NOTIFY_GRACE_SEC`（默认 180）为上线通知宽限期。

> **供应链完整性（审查 B3/B4）**：安装脚本以 root 执行，从 GitHub Release 下载二进制并默认校验 `.sha256`（可用 `SP_AGENT_GO_SKIP_SHA256=1` 跳过，**生产切勿设置**）。更強的推荐：发布物附 cosign 或 gpg 签名，安装时先验签。敏感参数（`AGENT_TOKEN`/`SETUP_TOKEN`）建议用 `--token-file`/`--setup-token-file` 从文件读取，或经环境变量/临时文件传递——避免出现在 `ps` 输出与 shell history 中。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERVER_URL` | 必填 | 服务端 `/api/report` 地址，强制 HTTPS（`localhost`/`127.0.0.1`/`::1` 允许 http） |
| `AGENT_ID` | 必填 | 独立 agent 标识 |
| `AGENT_TOKEN` | 必填 | 上报 token（随 `agent.env` 落盘，权限 600；传输仅经 HTTPS 头） |
| `DISK_PATH` | `/` | 顶层磁盘聚合根 |
| `INTERVAL` | `20` | 固定模式间隔秒（`ADAPTIVE=false` 时生效，最小 5） |
| `MONTH_ROTATE` | `0` | 流量重置日：`0`=累计口径，`1–31`=每月重置日；兼容别名 `AGENT_MONTH_ROTATE`，仅 Go 受控端生效 |
| `DEBUG` | `0` | `1`/`true` 打印调试日志（不打印 token） |
| `PROBE_TARGETS` | `CM:www.10086.cn:443,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8` | 探测目标；**显式设空 `""` 可关闭探测**。TCP 用 `label:host[:port]`，HTTP(S) 用 `label:http(s)://host/path`（https 附带证书剩余天数）。运营商 DNS 对 TCP 全拒，`CM` 为移动门户 |
| `PROBE_TIMEOUT_MS` | `900` | TCP 单次握手死线（毫秒） |
| `PROBE_RESOLVE_MS` | `900` | 主机名解析死线（毫秒）；超时为「无采样」 |
| `NET_IFACE_FILTER` | `1` | 网络计数接口过滤：`0` 关闭，回退旧口径（全部非 lo 接口） |
| `NET_IFACE_ONLY` | — | 接口白名单（逗号分隔完整接口名）：非空时只统计这些接口、忽略全部内置排除规则（隧道即唯一上行的节点必须设置） |
| `ADAPTIVE` | `1`（开） | `0`/`false` 关闭自适应，改用固定 `INTERVAL` |
| `FAST_INTERVAL` | `10` | 自适应快档间隔秒（指标显著变化时） |
| `SLOW_INTERVAL` | `60` | 自适应慢档间隔秒（平稳时） |

### 自适应上报（默认开启）

Go 受控端默认根据**本地指标变化率**自动切换快慢档：CPU / 内存 / 网络 / 负载显著变化时用 `FAST_INTERVAL`（默认 10s）实时捕捉，平稳时用 `SLOW_INTERVAL`（默认 60s）省流量。

**安全边界**：该决策**完全在 agent 本地完成，不解析服务端任何响应**——不使用"服务端回传在线人数"之类的下行通道，守住 diting「agent 从不解析 / 执行响应」的核心安全模型（与 Nezha 的 `CommandTask` 指令通道有本质区别）。

**配套服务端配置（必须）**：慢档 60s 会撞服务端默认 `OFFLINE_THRESHOLD_SEC=60`，需将服务端 `.env` 设为 `OFFLINE_THRESHOLD_SEC=120`（或大于慢档），否则平稳期会因 `last_seen` 间隔过大被误判离线。该改动不涉及 agent 侧。

### 迁移提示

- **不得共用同一 `AGENT_ID`**（否则 `last_seen` / 指标互相覆盖）；如需并行对比，注册两个独立 agent。
- 原 Python 节点迁移：在 Go 版安装时沿用原 `AGENT_ID` 与 Token 即可保留历史归属，随后删除旧 Python 服务/容器（Linux 见 `agent-go/uninstall.sh`，Windows 见《Windows 受控端》）。
- 已下线的 Python 实现（`agent/`）不再接受问题反馈与安全修复。

## 连接地址（SERVER_URL / Agent 专用连接地址）选型

Agent 只做**出站 HTTPS POST** 到 `/api/report`，没有长连接，因此 `SERVER_URL`（对应后台「站点信息 → Agent 专用连接地址」）有两种合法填法，按部署目标二选一。

### 方案 A：走盾（隐藏源站 IP）

把地址填成 Cloudflare **代理域名（橙云）**，流量经过 CF WAF：

```bash
SERVER_URL=https://monitor.example.com          # 走 443
# 或源站监听 8443 且已在 CF 开启代理：
SERVER_URL=https://monitor.example.com:8443
```

- CF 仅代理固定端口，HTTPS 为 `443 / 2053 / 2083 / 2087 / 2096 / 8443`。**其余端口（含 4443）CF 不代理**，连域名:4443 会直接失败，并非"绕过盾"。
- CF 的 SSL 模式需设为 **Full** 或 **Full (strict)**。
- 优点：源站 IP 始终被 CF 隐藏；缺点：受 WAF 规则与免费版限流影响，严格规则可能误杀 `/api/report`。

### 方案 B：直连（不套盾，最稳）

让 Agent **直连源站**，绕过 CF：

```bash
SERVER_URL=https://agent.example.com:4443       # 灰云(DNS-only)子域名 + 自有证书
# 或源站公网 IP（需自有证书，公网 CA 一般不为裸 IP 签发）：
SERVER_URL=https://1.2.3.4:4443
```

- 该 DNS 记录必须设为**灰云（仅 DNS，不代理）**，或用源站公网 IP，否则仍会经过 CF。
- Agent 强制 HTTPS，直连地址必须持有有效证书（建议用灰云子域名签 Let's Encrypt，而非裸 IP）。
- 优点：无中间层、最稳定、不怕 WAF 误杀；缺点：源站 IP 对该地址可见（但仅写在 `agent.env` / 安装脚本里，访客看不到）。

### 与后台「站点信息」的关系

后台「设置 → 站点信息」有两项，互不冲突：

- **项目网址**：填套盾的公网域名（如 `https://monitor.example.com`），供前台/后台互跳，访客只接触这个地址。
- **Agent 专用连接地址**：填方案 A 或 B 的地址，仅 Agent 上报与安装脚本使用，不对外暴露。

### 选型建议

| 你的目标 | 推荐方案 | SERVER_URL 示例 |
|---|---|---|
| 彻底隐藏源站 IP | A 走盾 | `https://monitor.example.com` |
| 追求稳定 / 怕 WAF 误杀 | B 直连 | `https://agent.example.com:4443` |

## 采集指标

| 指标 | Linux 来源 | Windows 来源 |
|---|---|---|
| CPU 使用率 | `/proc/stat` | Windows API（GetSystemTimes） |
| 内存使用率 | `/proc/meminfo` | GlobalMemoryStatusEx |
| 磁盘使用率 | `statvfs` | GetDiskFreeSpaceEx（全部固定盘求和，不含可移动盘） |
| 系统负载 | `/proc/loadavg` | 恒为 `0.0`（Windows 无 load 概念；**不用进程数近似**——进程列表属指纹字段） |
| 网络流量 | `/proc/net/dev` | GetIfTable2 |
| 温度 | `/sys/class/thermal/` | 尽力而为（部分机型无传感器时为空） |
| Swap | `/proc/meminfo` | 页面文件统计 |
| 开机时长 | `/proc/uptime` | GetTickCount64 |
| 网络质量 | 纯 TCP 握手，loss 为 **0/100 二值** | 同左 |

> 网络质量探测（`probes`）为**纯 TCP 握手**（不需 `CAP_NET_RAW`，也没有 ICMP 丢包统计），
> `loss` 只取 **0（握手成功）/ 100（三轮全失败）** 二值，不伪造中间值——
> 「三轮重试中几次失败」不代表链路丢包率。

### 月流量清零口径

Go 受控端只上报绝对计数器 `net_rx` / `net_tx` 与重置日 `month_rotate`，
月累计（`net_rx_month` / `net_tx_month`）由**服务端** `traffic_state` 累加器
统一计算并回写（见 `TRAFFIC_PLAN` P1/P4）：周期口径（`month_rotate`，含短月顺延、
闰年边界）由服务端按管理员设置或 agent 上报值决定，agent 本地不再持久化任何
流量状态。时区口径统一在服务端配置，与 agent 容器时区无关。

### Windows 上报间隔差异

Windows 版 `INTERVAL` 默认 **15s**；Linux systemd 安装与 Go 配置兜底为 **20s**；**Docker 镜像为 15s**
（`agent-go/Dockerfile` 与 `agent-go/docker-compose.yml` 的 `ENV INTERVAL=15`）。这是历史遗留差异，
**不修复**（服务端默认离线阈值 60s，15/20s 均在安全范围）；Docker 形态如需 20s，
显式传 `-e INTERVAL=20` 覆盖。

## 卸载

```bash
# 幂等，可重复执行；保留 /etc/diting/agent.env 与 state.json
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/agent-go/uninstall.sh | bash
```

> 需要彻底清理（含配置与月流量状态）时，在卸载脚本基础上自行删除 `/opt/diting`、`/var/lib/diting`、
> `/etc/diting` 并 `userdel diting`。原 Python 版卸载脚本已随 `agent/` 一并下线。
