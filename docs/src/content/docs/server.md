---
title: 服务端部署
description: 服务端配置与管理
---

# 服务端部署

## 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `PORT` | 否 | 监听端口 | `8081` |
| `ADMIN_TOKEN` | 首次 | 管理员 Token（≥16 位；弱口令只在启动时打印告警、**不阻止启动**，未设时走 Web 初始化向导生成） | — |
| `SETUP_TOKEN` | 否 | 受控端自助注册令牌 | — |
| `DB_PATH` | 否 | SQLite 数据库路径 | `/data/monitor.db` |
| `SESSION_SECRET` | 推荐 | Session 签名密钥（固定则重启不失效） | 随机生成 |
| `OFFLINE_THRESHOLD_SEC` | 否 | 离线判定阈值（秒） | `60` |
| `RETENTION_DAYS` | 否 | 指标保留天数 | `30` |
| `ALERT_CPU_PCT` / `ALERT_MEM_PCT` | 否 | CPU/内存告警阈值（%） | `90` |
| `ALERT_COOLDOWN_SEC` | 否 | 告警冷却（秒） | `1800` |
| `ALERT_WINDOW_SAMPLES` / `ALERT_TRIGGER_RATIO` | 否 | 采样窗口 / 触发比例（窗口内超限占比） | `5` / `0.7` |
| `ONLINE_NOTIFY_GRACE_SEC` | 否 | 上线通知宽限期（秒），`0` 关闭 | `180` |

## Docker Compose 配置

```yaml
version: '3'
services:
  server:
    image: ghcr.io/fengzone85/diting:latest
    ports:
      - "127.0.0.1:8081:8081"   # 仅回环，由 Nginx + TLS 反代对外
    volumes:
      - server-data:/data
    environment:
      - ADMIN_TOKEN=your-admin-token   # 管理员 Token（≥16 位）
      - SESSION_SECRET=your-session-secret
    restart: unless-stopped
volumes:
  server-data:
```

## 数据库

服务端使用 SQLite 单文件数据库，默认路径 `/data/monitor.db`（可用 `DB_PATH` 覆盖）。Docker 部署建议挂到命名卷 `server-data` 持久化。

### 备份与恢复

通过 `diting.sh` 管理命令操作，无需手动定位文件或停服：

```bash
# 热备份（通过 sqlite3 .backup，不中断服务）
sudo bash diting.sh --backup

# 从备份恢复（自动先备份当前状态，可回滚）
sudo bash diting.sh --restore /var/backups/diting/monitor_20260723.db

# 列出备份
sudo bash diting.sh --backup-list

# 查看统计
sudo bash diting.sh --db-stats
```

### 数据保留（自动清理）

服务端每小时自动清理过期的指标数据，控制数据库体积。保留天数可配置：

- **后台设置**（推荐）：「设置 → 站点与界面 → 指标保留天数」，范围 7-3650 天，保存后 1 小时内自动生效
- **环境变量**：`RETENTION_DAYS`（默认 30 天），后台未设置时生效
- **优先级**：后台设置 > 环境变量 > 默认 30 天

```bash
# docker-compose.yml 环境变量示例（后台未设置时生效）
environment:
  - RETENTION_DAYS=60   # 保留 60 天
```

### 数据迁移

将备份文件复制到新服务器后执行恢复：

```bash
# 新服务器上
sudo bash diting.sh --restore /path/to/monitor_backup.db
```

### 定时备份

```bash
# 安装每日自动备份（cron 会写入两行：每日备份 + 每 5 分钟处理后台恢复请求）
sudo bash diting.sh --backup-schedule install

# 查看 / 取消
sudo bash diting.sh --backup-schedule status
sudo bash diting.sh --backup-schedule uninstall
```

备份默认压缩（优先 `pigz`，无则回退 `gzip`；体积约为库的 20%）并按保留天数轮转。
后台「设置 → 数据库备份」可调整**周期（off/daily/weekly）、保留天数、是否压缩**——这三项由 cron 里的
`BACKUP_AUTO=1 diting.sh --backup` 实时读取，改完即时生效、无需重建定时任务；
但**执行小时**在 `--backup-schedule install` 时写死进 cron（默认凌晨 3 点，`diting.sh:1234-1260`），
后台改「执行小时」不会改变实际备份时刻，需手动 `crontab -e` 改那一行或重跑 install。

## 进程守护

### systemd

```ini
[Unit]
Description=DiTing Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/diting-src/server
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production
Restart=always
User=diting

[Install]
WantedBy=multi-user.target
```

## HTTPS 配置

受控端强制 HTTPS（非 localhost 请求 `exit(1)`），服务端需配置有效证书。

推荐使用 Caddy 自动申请 Let's Encrypt 证书：

```
monitor.example.com {
    reverse_proxy 127.0.0.1:8081
}
```

## 安全加固清单

- [ ] 设置强随机 `ADMIN_TOKEN`（弱口令只在启动时告警，不会拦截启动；未设时走 Web 初始化向导）
- [ ] 启用 TOTP 2FA
- [ ] 配置 HTTPS（受控端强制 HTTPS）
- [ ] 设置 CSP 头
- [ ] 限制访问 IP（可选）
- [ ] 定期备份数据库（`diting.sh --backup`）
