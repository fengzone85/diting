---
title: 安装指南
description: 各平台安装方式汇总
---

# 安装指南

DiTing 支持多种部署方式，按需选择。

## 方式对比

| 方式 | 适用场景 | 资源占用 | 部署时间 |
|---|---|---|---|
| Docker Compose | 有 Docker 环境 | 65-150MB | 5 分钟 |
| 原生 Node + systemd | 无 Docker / 精简 | 30-60MB | 10 分钟 |
| 原生受控端 | 小内存机器 | 12-25MB | 3 分钟 |

## 服务端安装

### Docker 部署

```bash
git clone https://github.com/fengzone85/diting.git
cd diting
cp server/.env.example server/.env
# 编辑 server/.env 设置 ADMIN_TOKEN、域名等
docker compose up -d
```

### 原生部署

```bash
git clone https://github.com/fengzone85/diting.git
cd diting/server
npm install --production
cp .env.example .env
# 编辑 .env
npm start
```

建议配合 systemd 或 PM2 做进程守护。

## 受控端安装

详见 [受控端部署](/agent/) 和 [原生 Linux 部署](/native/)。

## 数据库管理

安装脚本集成数据库备份/恢复/统计命令，无需手动定位文件或停服：

```bash
# 备份数据库（默认存到 /var/backups/diting/）
sudo bash diting.sh --backup

# 备份到指定路径
sudo bash diting.sh --backup /tmp/my-backup.db

# 从备份恢复（恢复前自动备份当前状态，可回滚）
sudo bash diting.sh --restore /var/backups/diting/monitor_20260723_141022.db

# 备份并指定保留天数（默认 14 天，超出自动清理最旧的 monitor_*.db；0=不清理）
sudo bash diting.sh --backup --keep-days 30

# 列出已有备份（含占用总量、时间跨度、定时状态）
sudo bash diting.sh --backup-list

# 查看数据库统计（大小/记录数/时间范围）
sudo bash diting.sh --db-stats

# 每日自动备份（cron，默认凌晨 3 点）
sudo bash diting.sh --backup-schedule install     # 安装（幂等，重复安装不会重复添加）
sudo bash diting.sh --backup-schedule status      # 查看是否已启用
sudo bash diting.sh --backup-schedule uninstall   # 取消（只移除本脚本添加的标记行）

# 关闭压缩（默认开启；环境无 pigz/gzip 时会自动跳过）
sudo bash diting.sh --backup --no-compress
```

| 参数 | 说明 |
|---|---|
| `--backup [路径]` | 备份（路径须以 `/` 或 `./` 开头；默认存 `/var/backups/diting/`） |
| `--keep-days N` | 备份保留天数（默认 14，超期自动清理；`0` = 不清理） |
| `--compress` / `--no-compress` | 是否 gzip 压缩（**默认压缩**，体积约 20%） |
| `--restore <文件>` | 从备份恢复，`.db` 与 `.db.gz` 均可 |
| `--backup-list` | 列出备份（占用总量、时间跨度、定时状态） |
| `--backup-schedule <动作>` | `install` / `uninstall` / `status` |
| `--process-restore` | 处理后台投递的恢复请求，**仅供 cron 调用** |

**恢复安全机制**：
- 恢复前自动备份当前数据库（`pre_restore_*.db`），误操作可回滚
- 备份文件自动校验 SQLite 完整性（魔数 + `PRAGMA integrity_check`）
- 终端手动执行时需输入 `yes` 确认才覆盖；由后台/定时任务触发时跳过确认
  （发起方本身已是管理员显式操作，且流程内已强制备份当前状态）

**恢复的两种入口**：

| 入口 | 命令 | 适用 |
|---|---|---|
| 终端 | `sudo bash diting.sh --restore <文件>` | SSH 直连，同步执行、当场看结果 |
| 网页 | 后台「设置 → 数据库备份 → 备份文件 → 恢复」 | 异步：投递请求，等宿主 cron 处理（≤5 分钟） |

网页入口依赖 `--process-restore`（由 `--backup-schedule install` 写入的 cron 每 5 分钟调用，
**不要手动执行**）。它读取宿主备份目录里的 `restore.request`，取出文件路径后走与
手动恢复完全相同的流程。

**保留与轮转**：默认保留 14 天，超期的 `monitor_*.db[.gz]` 会在每次备份后自动清理；
`pre_restore_*.db[.gz]`（恢复前的回滚点）永不自动删除，需人工确认后再删
（它每恢复一次就多一份，占用等于库体积，建议定期检查 `/var/backups/diting/`）。
可用 `--keep-days N` 或环境变量 `DB_BACKUP_KEEP_DAYS` 调整，设为 `0` 关闭清理。

**压缩（默认开启）**：备份默认用 `pigz`（并行 gzip，无则回退 `gzip -6`）压缩成 `.db.gz`。
数据库含大量已删数据留下的空闲页且数值重复度高，实测可压到原体积约 **20%**
（1.5G 库 → 约 322M，耗时约 22s；对比 `gzip -9` 需 3m19s 且只小 8M）。
关闭：`--no-compress` 或 `DB_BACKUP_COMPRESS=0`（环境无 pigz/gzip 时自动跳过）。
`--restore` 同时接受 `.db` 与 `.db.gz`。

**空间预检与自愈**：备份前先按库体积预估需求并比对目标分区可用空间；不足时
先按保留策略清理过期备份，仍不足则继续清理最旧的（至少保留最新 1 份，
且不碰 `pre_restore_*`），最后仍不够才报错退出 —— 避免「磁盘写满后
备份失败、清理又在成功后才跑」导致的死锁。

**定时备份说明**：`--backup-schedule install` 会写入**两行** cron，都带 `# diting-backup`
标记（卸载时按标记精准移除，不会动你已有的其它定时任务）：

| 频率 | 任务 | 日志 |
|---|---|---|
| 每日 | `BACKUP_AUTO=1 diting.sh --backup` | `/var/backups/diting/backup.log` |
| 每 5 分钟 | `diting.sh --process-restore`（消费后台恢复请求） | `/var/backups/diting/restore.log` |

两行都会先 `source /etc/diting/host.env`（若存在），以取得 `BACKUP_VISIBLE_DIR` /
`RESTORE_REQUEST_FILE` —— 所以**改了 host.env 无需重装定时任务**。
若提示未检测到 `crontab`，先安装 cron（Debian/Ubuntu: `apt-get install -y cron`）。

**周期可在后台调整**：cron 固定每日触发一次，是否真正执行由后台
「设置 → 数据库备份」的周期决定（`off` / `daily` / `weekly`，以及执行小时、
保留天数、是否压缩）。因此改周期**无需重建定时任务**，即时生效。

**备份监控**：每次备份完成后，脚本会把结果回写数据库（最近时间、状态、文件名、
体积、耗时、占用、错误），后台「设置 → 数据库备份 → 备份监控」可直接查看；
超过 48 小时没有成功备份会给出提示。注意备份状态存在独立配置项里，
不受设置页整体保存的影响。

### 在后台管理备份文件（列表 / 下载 / 恢复 / 删除）

后台「设置 → 数据库备份 → 备份文件」可以直接浏览、下载、恢复、删除备份。
**这一步是可选的** —— 不做也能正常备份/恢复，只是备份文件不会出现在网页里。

前提是让服务端能读到备份目录（Docker 部署默认读不到宿主的 `/var/backups/diting`）。
**必须按顺序执行**，否则后台列表是空的：

```bash
# 1) 宿主侧：建目录，并登记给后台（diting.sh 每次运行都会读这个文件）
sudo mkdir -p /opt/diting-backups
sudo chown "$(whoami)" /opt/diting-backups        # 容器/服务端需要可写
echo 'BACKUP_VISIBLE_DIR=/opt/diting-backups' | sudo tee -a /etc/diting/host.env

# 2) 服务端：告诉它备份目录在哪
#    Docker 部署 —— 挂载宿主目录进容器，必须重建才生效
echo 'HOST_BACKUP_DIR=/opt/diting-backups' >> server/.env
sudo bash diting.sh --update-server
#    原生/systemd 部署（直接跑 node server.js）—— 无需挂载，指同一路径即可
#    echo 'BACKUP_DIR=/opt/diting-backups' >> server/.env
#    echo 'RESTORE_TRIGGER=/opt/diting-backups/restore.request' >> server/.env
#    sudo systemctl restart simple-probe-server.service

# 3) 安装定时任务（含「每 5 分钟处理后台恢复请求」那一行，恢复功能依赖它）
sudo bash diting.sh --backup-schedule install

# 4) 验证：做一次备份，然后看后台是否列出
sudo bash diting.sh --backup
sudo bash diting.sh --backup-list
```

- **备份脚本会自动把新备份同步一份到 `BACKUP_VISIBLE_DIR`**（未配置则不复制），
  所以后台看到的就是这个目录里的实际文件。恢复前的回滚快照 `pre_restore_*`
  **不会**同步（每恢复一次就多一份，同步会让占用翻倍），需要时到
  `/var/backups/diting/` 取。
- **下载**走 `GET /api/admin/backups/:name/download`，同源流式返回（实测 322MB 约 1.6s）。
- **删除**只允许本脚本生成的命名（`monitor_*` / `pre_restore_*`），
  目录里的其它文件不会被列出也不会被删。
- **恢复**是**异步**的：后台只投递请求文件（落在宿主备份目录内），
  由宿主侧 `diting.sh --process-restore` 执行（cron 每 5 分钟轮询一次），
  真正恢复时仍会走「恢复前自动备份 → 完整性校验 → 停服原子替换 → 重启」全流程。
  若长时间未生效，检查宿主是否已 `--backup-schedule install` 且配置了 `/etc/diting/host.env`。

> **注意**：网页点「恢复」时不需要再输入 `yes`（按钮本身已是管理员显式操作，
> 带写保护与审计日志，且流程内强制先备份当前状态可回滚）；
> 在终端手动 `--restore` 时仍会要求输入 `yes` 二次确认。

## 数据保留与自动清理

服务端每小时自动清理过期的指标数据（`metrics` 表），控制数据库体积。

| 配置方式 | 说明 | 优先级 |
|---|---|---|
| 后台设置（推荐） | 「设置 → 告警规则 → 指标保留天数」，范围 7-3650 天 | 高 |
| 环境变量 | `RETENTION_DAYS`（docker-compose / .env） | 中 |
| 硬编码默认 | 30 天 | 低 |

后台设置保存后 1 小时内自动生效，无需重启服务。

## 反向代理

推荐使用 Nginx 或 Caddy 配置 HTTPS：

```nginx
server {
    listen 443 ssl http2;
    server_name monitor.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
