---
title: 环境变量
description: 服务端与受控端环境变量参考
---

# 环境变量

完整示例见 `server/.env.example`。

## 服务端（`.env`）

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `8081` | HTTP 监听端口 |
| `ADMIN_TOKEN` | 否 | — | **已废弃，仅存量迁移用**。管理员 Token 改由浏览器 `/install` 向导创建，**库中只存 sha256 哈希**（`admin_config.admin_token_hash`），明文只在完成页显示一次。存量部署保留此变量以便启动时把旧明文迁进库，迁移后启动日志提示「已废弃」且该值不再参与鉴权；重置用 `sudo bash diting.sh --reset-admin-token`。**Docker 形态的 compose 已不再注入本变量**，升级时由 `diting.sh` 在停容器前完成迁移 |
| `SESSION_SECRET` | 推荐 | 随机 | Session Cookie 签名密钥。⚠️ 生产务必设为随机长字符串（`openssl rand -hex 32`），留空则每次重启随机、所有已登录会话失效 |
| `SESSION_TTL_MS` | 否 | `43200000` | 登录态有效期（毫秒，默认 12 小时） |
| `APT_MIRROR` | 否 | — | **仅构建期生效**（`docker-compose.yml` 的 `build.args` 读取）。回退本地编译 better-sqlite3 时用它替换 apt 源，如 `mirrors.aliyun.com`；预编译二进制可用时根本不装编译工具链，此项无需设置 |
| `NOTIFY_GROUPS` | 否 | `1` | 设为 `0` 时通知整体退回「邮件 + Telegram 直发」的旧路径（忽略通知组与事件路由），用于通知组上线后的紧急灰度回退 |
| `STRICT_SESSION_DB` | 否 | `0` | 设为 `1` 时，会话表查询失败一律拒绝会话（fail-close）。默认 `0` = fail-open：签名有效且未过全局吊销水位线即放行，避免单机 SQLite 异常把管理员永久锁死。详见「安全设计 → 登录会话管理」 |
| `READONLY_TOKEN` | 否 | — | 只读 Token（仅可调用只读 GET 接口）。建议 ≥16 位随机值；占位符 / 过短时启动告警（仍生效），因其可读全部节点指标与备份列表。⚠️ 这是**全局静态凭证**：不可吊销（改值需重启）、无审计、不能限节点——需要这些能力时改用后台签发的 API Token（`scope` + `agent_ids`，见「API 接口 → 签发 / 吊销 API Token」） |
| `SETUP_TOKEN` | 否 | — | 受控端自助注册令牌（`--setup-token` 用）。**以数据库为权威**：本值仅在首次使用时被自动搬进库，之后改这里不生效；日常维护到 管理后台 → 设置 → 受控端自助注册令牌（生成/清除，明文只显示一次）。过弱的令牌（纯数字/字符种类过少/含连续序列）会被拒绝启用 |
| `DB_PATH` | 否 | `/data/monitor.db` | SQLite 数据库路径 |
| `AGENT_INTERVAL` | 否 | `20` | 期望上报间隔（用于离线判定与超阈值分钟数换算） |
| `AI_TREND_DAYS` | 否 | `7` | AI 日报磁盘趋势窗口（天）。范围 2–14，自动收敛到不超过 `RETENTION_DAYS`；`0` = 关闭趋势、回退旧的「24 小时首末两点」算法 |
| `AI_COMPARE` | 否 | `1` | 周期对比：为摘要附加「当期 − 前一等长窗口」的同单位差值（`compare` 字段），让模型能说「较前一日上升 X」而不是只能看当前值。设为 `0` 关闭（省一次同规模采样查询） |
| `AI_KEY_FROM_ENV` | 否 | `0` | 设为 `1` 时 AI 的 API Key 只从 `AI_API_KEY` 环境变量读取、不落库（后台表单中的 Key 字段失效） |
| `AI_API_KEY` | 否 | — | 配合 `AI_KEY_FROM_ENV=1` 使用：模型服务的 API Key |
| `OFFLINE_THRESHOLD_SEC` | 否 | `60` | 离线判定阈值（秒） |
| `RETENTION_DAYS` | 否 | `30` | 指标保留天数（7–3650） |
| `AUDIT_RETENTION_DAYS` | 否 | `90` | 管理员操作审计日志保留天数（下限 7）。独立于 `RETENTION_DAYS`：审计属安全记录，默认保留更久 |
| `PROBES_DOWNSAMPLE` | 否 | `1` | 延迟波形后端时间桶聚合（`0` 关闭） |
| `PROBES_MAX_POINTS` | 否 | `5000` | 每标签点数上限（硬上限 50000） |
| `ALERT_CPU_PCT` / `ALERT_MEM_PCT` | 否 | `90` | CPU / 内存告警阈值（%） |
| `ALERT_COOLDOWN_SEC` | 否 | `1800` | 告警冷却时间（秒） |
| `ALERT_WINDOW_SAMPLES` | 否 | `5` | 告警采样窗口（2–20）：窗口内超限占比达到比例才触发/恢复 |
| `ALERT_TRIGGER_RATIO` | 否 | `0.7` | 触发/恢复比例（0.1–1.0）；与窗口共同决定「持续多久算异常」 |
| `ALERT_SUSTAIN_SAMPLES` | 否 | — | **兼容开关**：显式设置时退回旧行为（窗口=N、比例=1.0，即连续 N 次全超限） |
| `ONLINE_NOTIFY_GRACE_SEC` | 否 | `180` | 离线超过该秒数后重连才发「已上线」通知；`0` = 关闭上线通知 |
| `NOTIFY_CONCURRENCY` | 否 | `8` | 单次事件最多并发的通知渠道数 |
| `THEMES_DIR` | 否 | `<DB_PATH 同级>/data/themes` | 主题市场安装目录（随数据卷持久）；`public/themes` 仅作为只读内置目录 |
| `ALLOW_PRIVATE_WEBHOOK` | 否 | — | 设为 `1` 允许 Webhook 指向私网/回环地址（默认拒绝，防 SSRF；内网自托管接收端按需开启） |
| `ALLOW_INSECURE_WEBHOOK` | 否 | — | 设为 `1` 允许明文 `http://` Webhook（默认仅 `https://`） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | 否 | `smtp.qq.com` / `465` / `true` | 告警邮件 SMTP |
| `SMTP_USER` / `SMTP_PASS` | 否 | — | SMTP 用户名 / 密码（QQ 邮箱用授权码） |
| `ALERT_FROM` / `ALERT_TO` | 否 | — | 告警发件人 / 收件人 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 否 | — | Telegram 告警（与邮件并行） |
| `ADMIN_ALLOW_HTTP` | 否 | — | 设为 `1` 允许 HTTP（仅内网测试） |
| `TRUST_PROXY` | 否 | `loopback` | 可信反向代理（决定 `req.ip` 取转发头还是 TCP 源地址） |
| `PUBLIC_URL` | 推荐 | — | 服务端公网地址，用于生成受控端一键安装命令（也可在后台「设置 → Agent 连接地址」配置） |
| `AGENT_RAW_REPO` | 否 | `https://raw.githubusercontent.com/fengzone85/diting/master` | 一键命令中 `diting.sh` / 安装脚本的 raw 基址（可钉 tag） |
| `AGENT_GIT_REPO` | 否 | `https://github.com/fengzone85/diting.git#master:agent-go` | Docker 受控端一键命令的构建源（M3 起为 Go） |
| `ALERT_CONCURRENCY` | 否 | `8` | 告警并发发送上限 |
| `BACKUP_DIR` | 否 | `/data/backups` | 备份目录。Docker 下是**容器内路径**，需 compose 把宿主目录挂到此路径（`HOST_BACKUP_DIR` 指定宿主来源）；**原生部署下应写宿主路径**（如 `/var/backups/diting`），此时 `diting.sh --backup` 会直接跟随这里的值，后台「备份」页与 CLI 指向同一目录（否则后台会显示"目录不可用"、看不到 CLI 产物） |
| `RESTORE_TRIGGER` | 否 | `/data/restore.request` | 后台点「恢复」时投递的请求文件。代码兜底默认在 `/data/` 下；compose 示例传 `/data/backups/restore.request`（与 `BACKUP_DIR` 同卷）。宿主侧 `diting.sh --process-restore` 读取并执行 |
| `BACKUP_UPLOAD_MAX_MB` | 否 | `1024` | 后台「上传备份」的单文件上限（MB，1–8192）。上传内容必须是 SQLite 或 gzip，文件名由服务端生成；超限返回 413 |

> AI 日报、计费、审计、Komari 主题由后台「设置」页管理，无需环境变量。

### 备份相关（宿主机侧）

以下变量写在 `/etc/diting/host.env`（**不是** `server/.env`），由 `diting.sh`
每次运行读取，也由 `--backup-schedule install` 写入的 cron 行 `source`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BACKUP_VISIBLE_DIR` | — | 备份同步目标目录。设了它，每次备份会额外复制一份到此目录（即 `HOST_BACKUP_DIR` 指向的宿主目录），后台才能列出/下载；不设则不复制 |
| `RESTORE_REQUEST_FILE` | — | 恢复请求文件路径（宿主侧），应与容器内 `RESTORE_TRIGGER` 指向同一个文件 |

| 变量 | 默认 | 说明 |
|---|---|---|
| `DB_BACKUP_KEEP_DAYS` | `14` | 备份保留天数（`0` = 不自动清理），等价于 `--keep-days` |
| `DB_BACKUP_COMPRESS` | `1` | 是否 gzip 压缩备份（`0` = 关闭），等价于 `--no-compress` |

> 传输中的备份是**完整数据库快照**（含全部 Agent Token 哈希、设置项），
> 下载后请按敏感文件保管。

### `TRUST_PROXY`：反向代理信任边界

`req.ip` 用于管理端 IP 白名单、按 IP 限流与审计记录。它取自 `X-Forwarded-For` 还是 TCP 源地址，由 `trust proxy` 决定：

| 部署形态 | 需要设置 |
|---|---|
| Nginx 与服务端同机，8081 只绑 `127.0.0.1`（推荐） | 无需设置（默认 `loopback`） |
| Nginx 在另一台主机 / 另一个容器 | `TRUST_PROXY=172.16.0.0/12,10.0.0.8`（逗号分隔 IP 或 CIDR） |
| 固定一跳反代 | `TRUST_PROXY=1` |

⚠️ 2026-09-10 起默认从 `trust proxy = true`（信任任意来源）收紧为 `loopback`：只要 `8081` 能被直连，客户端就能自造 `X-Forwarded-For` 绕过 IP 白名单与限流，或自造 `X-Forwarded-Proto: https` 让管理接口走明文 HTTP。**反代与服务端不同机的部署升级后必须显式设置 `TRUST_PROXY`**，否则 `req.ip` 会变成反代 IP，配了白名单的站会全部被 403。

## 受控端

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `SERVER_URL` | ✅ | — | 服务端 URL（非 localhost 必须为 HTTPS，否则 `exit(1)`） |
| `AGENT_ID` | ✅ | — | 节点标识 |
| `AGENT_TOKEN` | ✅ | — | 认证令牌 |
| `INTERVAL` | 否 | `20`（Docker 镜像与 Windows 为 `15`） | 上报间隔（秒），最小 5 |
| `MONTH_ROTATE` | Go | `0` | 流量重置日（Komari `month_rotate`）：`0`=累计口径，`1–31`=每月重置日；兼容别名 `AGENT_MONTH_ROTATE`。由服务端按此口径累计月流量（受控端不保存本地状态） |
| `DISK_PATH` | 否 | `/` | 磁盘统计路径（容器内通常为 `/host`） |
| `PROBE_TARGETS` | 否 | `CM:www.10086.cn:443,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8` | 网络质量探测目标（`label:host[:port]`，逗号分隔，置空关闭）。`CM` 为**移动门户**——运营商 DNS 对 TCP 53/443/80 全拒，故用移动自家门户测「移动入口可达性」 |
| `ADAPTIVE` | Go | on | 自适应采样：变化快 10s ↔ 慢 60s（Go Agent） |
| `DEBUG` | 否 | off | 详细日志（永不打印 Token） |

### PROBE_TARGETS 说明

- 多个目标用逗号分隔，格式 `label:host[:port]`（如 `CM:www.10086.cn:443`）
- Go 受控端为**纯 TCP** 握手探测（端口序：目标端口 → 443 → 80），`loss` 仅 `0` / `100` 二值、不伪造中间值
- **运行期无下发通道**：目标只在安装时由一键命令写入本地一次，之后只能在本机改——服务端没有任何 API 能在运行期推送探测目标
- `label` 建议用 ≤2 字符缩写（`CM`=移动门户 / `CT`=电信 / `CU`=联通 / `GG`=公共谷歌 DNS），状态卡片空间有限；默认 `PROBE_TARGETS=CM:www.10086.cn:443,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8`（运营商 DNS 对 TCP 全拒，CM 用移动自家门户测"移动入口可达性"）

### 网络质量探测示例

```bash
# 探测移动门户 + 电信/联通 DNS + 谷歌 DNS（默认，label 用两字母缩写）
PROBE_TARGETS=CM:www.10086.cn:443,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8

# 关闭探测
PROBE_TARGETS=
```

## Docker Compose 完整示例

```yaml
version: '3'
services:
  server:
    image: ghcr.io/fengzone85/diting:latest
    ports:
      - "127.0.0.1:${PORT:-8081}:${PORT:-8081}"   # 端口跟 .env 的 PORT 走（安装器 --port N 会自动写入）
    volumes:
      - server-data:/data
    environment:
      - PORT=${PORT:-8081}
      # 管理员 Token 不再由环境变量提供：首次访问 /install 向导创建，库中只存 sha256 哈希
      - SESSION_SECRET=openssl-rand-hex-32  # 务必改为强随机值
      - NODE_ENV=production
    restart: unless-stopped

  agent:
    image: ghcr.io/fengzone85/diting-agent:latest
    network_mode: host                      # 才能拿到真实 /proc/net/dev 流量
    environment:
      - SERVER_URL=https://monitor.example.com
      - AGENT_ID=your-agent-id
      - AGENT_TOKEN=your-agent-token
      - INTERVAL=15
      - MONTH_ROTATE=0
      - DISK_PATH=/host
    volumes:
      - /:/host:ro
      - /proc:/hostproc:ro
      - agent-state:/data
    restart: unless-stopped

volumes:
  server-data:
  agent-state:
```
