---
title: 快速开始
description: 5 分钟部署 DiTing
---

# 快速开始

## 前置条件

- 一台 VPS（推荐 1C1G，最低 512MB）
- Docker + Docker Compose **或** Node.js 22+
- 一个域名（可选，用于 HTTPS）

## 方式 1：Docker 部署（推荐）

```bash
git clone https://github.com/fengzone85/diting.git
cd diting
docker compose up -d
```

访问 `http://<你的IP>:8081` 即可看到仪表盘。

首次访问时用 `ADMIN_TOKEN` 环境变量登录管理端。

## 方式 2：原生 Node 部署

```bash
git clone https://github.com/fengzone85/diting.git
cd diting/server
npm install
npm start
```

## 添加受控端

### Linux（Docker）

```bash
docker run -d \
  --name diting-agent \
  --restart unless-stopped \
  --network host \
  -e AGENT_ID="<你的ID>" \
  -e AGENT_TOKEN="<你的Token>" \
  -e SERVER_URL="https://<你的域名>" \
  -e DISK_PATH=/host \
  -v /:/host:ro \
  -v /proc:/hostproc:ro \
  -v diting-state:/data \
  ghcr.io/fengzone85/diting-agent:latest
```

### Linux（原生 systemd）

```bash
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/agent/install.sh | bash
```

按提示输入 Server URL 和 Token 即可。

### Windows

下载 `agent/windows/` 下的脚本，以管理员身份运行 `install.ps1`。

## 数据管理

### 数据保留

服务端每小时自动清理过期指标。默认保留 30 天，可在「设置 → 告警规则」调整（7-3650 天），也可通过环境变量 `RETENTION_DAYS` 设置。

### 数据备份

部署完成后建议立即备份数据库，并设置定时自动备份：

```bash
# 首次备份
sudo bash diting.sh --backup

# 设置每日自动备份（幂等，重复执行不会产生重复条目）
sudo bash diting.sh --backup-schedule install

# 查看是否已启用
sudo bash diting.sh --backup-schedule status
```

> 默认备份到 `/var/backups/diting/`，带 gzip 压缩（体积约为数据库的 20%），
> 默认保留 14 天并自动清理过期文件。

> 数据库包含全部 Agent 记录、历史监控数据、设置项。Docker 重建容器不会丢失数据，但整机迁移或卷删除前需手动备份。

## 下一步

- [服务端详细配置](/server/)
- [受控端部署指南](/agent/)
- [安全加固](/security/)
- [安装指南 — 数据库管理](/install/#数据库管理)
