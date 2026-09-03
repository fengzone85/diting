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
| `ADMIN_TOKEN` | 首次 | — | 管理员 Token（≥16 位，弱口令启动即拦截） |
| `SESSION_SECRET` | 推荐 | 随机 | Session Cookie 签名密钥。⚠️ 生产务必设为随机长字符串（`openssl rand -hex 32`），留空则每次重启随机、所有已登录会话失效 |
| `SESSION_TTL_MS` | 否 | `43200000` | 登录态有效期（毫秒，默认 12 小时） |
| `READONLY_TOKEN` | 否 | — | 只读 Token（仅可调用只读 GET 接口） |
| `SETUP_TOKEN` | 否 | — | 受控端自助注册令牌（`--setup-token` 用） |
| `DB_PATH` | 否 | `/data/monitor.db` | SQLite 数据库路径 |
| `AGENT_INTERVAL` | 否 | `15` | 期望上报间隔（用于离线判定） |
| `OFFLINE_THRESHOLD_SEC` | 否 | `60` | 离线判定阈值（秒） |
| `RETENTION_DAYS` | 否 | `30` | 指标保留天数（7–3650） |
| `PROBES_DOWNSAMPLE` | 否 | `1` | 延迟波形后端时间桶聚合（`0` 关闭） |
| `PROBES_MAX_POINTS` | 否 | `5000` | 每标签点数上限（硬上限 50000） |
| `ALERT_CPU_PCT` / `ALERT_MEM_PCT` | 否 | `90` | CPU / 内存告警阈值（%） |
| `ALERT_COOLDOWN_SEC` | 否 | `1800` | 告警冷却时间（秒） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | 否 | `smtp.qq.com` / `465` / `true` | 告警邮件 SMTP |
| `SMTP_USER` / `SMTP_PASS` | 否 | — | SMTP 用户名 / 密码（QQ 邮箱用授权码） |
| `ALERT_FROM` / `ALERT_TO` | 否 | — | 告警发件人 / 收件人 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 否 | — | Telegram 告警（与邮件并行） |
| `ADMIN_ALLOW_HTTP` | 否 | — | 设为 `1` 允许 HTTP（仅内网测试） |

> AI 日报、计费、审计、Komari 主题由后台「设置」页管理，无需环境变量。

## 受控端（Python 与 Go 共用）

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `SERVER_URL` | ✅ | — | 服务端 URL（非 localhost 必须为 HTTPS，否则 `exit(1)`） |
| `AGENT_ID` | ✅ | — | 节点标识 |
| `AGENT_TOKEN` | ✅ | — | 认证令牌 |
| `INTERVAL` | 否 | `15` | 上报间隔（秒） |
| `DISK_PATH` | 否 | `/` | 磁盘统计路径（容器内通常为 `/host`） |
| `PROBE_TARGETS` | 否 | 移动/电信/联通 DNS + 8.8.8.8 | 网络质量探测目标（`label:host[:port]`，逗号分隔，置空关闭） |
| `STATE_FILE` | Go | `/data/state.json` | 月流量状态持久化文件（Go Agent） |
| `ADAPTIVE` | Go | on | 自适应采样：变化快 10s ↔ 慢 60s（Go Agent） |
| `GZIP` | 否 | off | 启用 Gzip 压缩上报（需服务端支持解压） |
| `DEBUG` | 否 | off | 详细日志（永不打印 Token） |

### PROBE_TARGETS 说明

- 多个目标用逗号分隔，格式 `label:host[:port]`（如 `移动:211.136.192.6`）
- ICMP 优先，失败自动 TCP 回退（默认探测 53 端口）
- **本地固定，服务端不可下发** — 这是核心安全设计

### 网络质量探测示例

```bash
# 探测三家运营商 DNS + 公共 DNS（默认）
PROBE_TARGETS=移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8

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
      - "127.0.0.1:8081:8081"
    volumes:
      - server-data:/data
    environment:
      - ADMIN_TOKEN=change-me-admin-token   # 务必改为强随机值
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
