---
title: 受控端部署
description: Agent 部署指南
---

# 受控端部署

DiTing 受控端支持三种部署形态，数据格式与上报契约完全相同，仅实现语言与部署方式不同。

## 形态对比

| | Docker (Python) | 原生 systemd (Python) | Go 二进制 |
|---|---|---|---|
| 内存占用 | 65-150MB | 12-25MB | <10MB |
| 前置依赖 | Docker Engine | Python 3.8+ | Go 工具链（仅构建期） |
| 安全隔离 | 容器 + diting 用户 + cap-drop(仅NET_RAW) + 只读挂载 | systemd 14 项加固 | scratch + USER 1000 + cap-drop（规划中） |
| 部署复杂度 | 一条命令 | 交互脚本 | 编译二进制 / 待发布镜像 |
| 适用场景 | 已有 Docker 环境 | 精简系统 / 小内存 | 极小体积 / 纯 Go 工具链 |
| 实现 | `agent.py` + `collector.py` | 同左 | `agent-go/`（直读 /proc，零依赖） |

## Docker 部署

```bash
docker run -d \
  --name diting-agent \
  --restart unless-stopped \
  --network host \
  -e AGENT_ID="<ID>" \
  -e AGENT_TOKEN="<Token>" \
  -e SERVER_URL="https://monitor.example.com" \
  -e DISK_PATH=/host \
  -v /:/host:ro \
  -v /proc:/hostproc:ro \
  -v diting-state:/data \
  ghcr.io/fengzone85/diting-agent:latest
```

> `--network host` 让容器共享宿主网络命名空间，`/proc/net/dev` 才能反映真实流量；`-v /:/host:ro` + `DISK_PATH=/host` 让磁盘统计针对 VPS 真实根盘而非容器 overlay。

## 原生 systemd 部署

```bash
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/agent/install.sh | bash
```

脚本会：
1. 检查 Python 3 环境
2. 创建 `/opt/diting-agent/` 目录（权限 700）
3. 复制 `agent.py` + `collector.py`
4. 生成 `agent.env`（权限 600，含 Token 和 Server URL）
5. 注册 systemd 服务（14 项安全加固）
6. 启动并设置开机自启

### systemd 安全加固项

| 加固项 | 说明 |
|---|---|
| `NoNewPrivileges=yes` | 禁止提权 |
| `ProtectSystem=strict` | 文件系统只读 |
| `ProtectHome=yes` | 隔离 /home |
| `PrivateTmp=yes` | 隔离 /tmp |
| `ProtectKernelTunables=yes` | 隔离内核参数 |
| `ProtectKernelModules=yes` | 禁止加载内核模块 |
| `ProtectControlGroups=yes` | 隔离 cgroup |
| `RestrictNamespaces=yes` | 禁止创建命名空间 |
| `RestrictRealtime=yes` | 禁止实时调度 |
| `RestrictSUIDSGID=yes` | 禁止 setuid/sgid |
| `MemoryDenyWriteExecute=yes` | 禁止可写可执行内存 |
| `LockPersonality=yes` | 锁定进程特性 |
| `SystemCallArchitectures=native` | 限制系统调用架构 |
| `CapabilityBoundingSet=` | 清空所有 capabilities |

## Go 受控端（二进制）

Go 受控端是 Python 版的**等价原生重写**：数据格式、上报契约、安全模型完全一致（直读 `/proc`、零外部依赖、强制 HTTPS、单向上报、零入站端口、无指令通道），仅实现语言不同。适合需要更小体积（~5MB 静态二进制、内存 <10MB）或纯 Go 工具链的场景。

> 当前以源码 / 二进制方式提供，官方 Docker 镜像与一键脚本待发布（设计上提供 scratch + `USER 1000` + `--cap-drop=ALL`）。以下以从源码构建为例。

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
STATE_FILE=/var/lib/diting-agent-go/state.json \
./diting-agent-go
```

> Go 版默认 `DISK_PATH=/`；容器内运行需配合 `-v /:/host:ro`（多盘识别优先读 `/hostproc/mounts`，回退 `/proc/mounts`）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERVER_URL` | 必填 | 服务端 `/api/report` 地址，强制 HTTPS（`localhost`/`127.0.0.1`/`::1` 允许 http） |
| `AGENT_ID` | 必填 | 独立 agent 标识 |
| `AGENT_TOKEN` | 必填 | 上报 token（仅经 HTTPS 头，不落盘） |
| `DISK_PATH` | `/` | 顶层磁盘聚合根 |
| `STATE_FILE` | `/data/state.json` | 月累计状态文件路径（建议权限 600） |
| `INTERVAL` | `20` | 固定模式间隔秒（`ADAPTIVE=false` 时生效，最小 5） |
| `DEBUG` | `0` | `1`/`true` 打印调试日志（不打印 token） |
| `PROBE_TARGETS` | 三家运营商 DNS + 8.8.8.8 | 探测目标；**显式设空 `""` 可关闭探测** |
| `ADAPTIVE` | `1`（开） | `0`/`false` 关闭自适应，改用固定 `INTERVAL` |
| `FAST_INTERVAL` | `10` | 自适应快档间隔秒（指标显著变化时） |
| `SLOW_INTERVAL` | `60` | 自适应慢档间隔秒（平稳时） |
| `GZIP` | `0`（关） | `1`/`true` 开启请求体 gzip（**需服务端先配解压中间件，否则上报被 400 拒收**） |

### 自适应上报（默认开启）

Go 受控端默认根据**本地指标变化率**自动切换快慢档：CPU / 内存 / 网络 / 负载显著变化时用 `FAST_INTERVAL`（默认 10s）实时捕捉，平稳时用 `SLOW_INTERVAL`（默认 60s）省流量。

**安全边界**：该决策**完全在 agent 本地完成，不解析服务端任何响应**——不使用"服务端回传在线人数"之类的下行通道，守住 diting「agent 从不解析 / 执行响应」的核心安全模型（与 Nezha 的 `CommandTask` 指令通道有本质区别）。

**配套服务端配置（必须）**：慢档 60s 会撞服务端默认 `OFFLINE_THRESHOLD_SEC=60`，需将服务端 `.env` 设为 `OFFLINE_THRESHOLD_SEC=120`（或大于慢档），否则平稳期会因 `last_seen` 间隔过大被误判离线。该改动不涉及 agent 侧。

### 与 Python 版的关系

- **不得共用同一 `AGENT_ID`**（否则 `last_seen` / 指标互相覆盖）；注册两个独立 agent 并排对比。
- 数据格式、服务端契约、安全模型完全一致，已本机实测验证（`mem_total` / `disk_total` / `swap_*` 完全相同）。
- 现有 Python 版保留，可随时切回。

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
| CPU 使用率 | `/proc/stat` | psutil |
| 内存使用率 | `/proc/meminfo` | psutil |
| 磁盘使用率 | `os.statvfs` | psutil |
| 系统负载 | `/proc/loadavg` | — |
| 网络流量 | `/proc/net/dev` | psutil |
| 温度 | `/sys/class/thermal/` | psutil |
| Swap | `/proc/meminfo` | psutil |
| 开机时长 | `/proc/uptime` | psutil |
| 网络质量 | ICMP/TCP ping | ICMP/TCP ping |

> Go 受控端当前仅支持 Linux，指标来源与 Python 版 Linux 完全一致（直读 `/proc`），两者上报数据可并排对比。Windows 暂仅由 Python 版支持。

## 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/agent/uninstall.sh | bash
```

完全幂等，可重复执行。
