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
cp server/.env.example server/.env
docker compose up -d
```

> `server/.env` 被 `.gitignore` 忽略、不会随仓库分发，必须先从 `.env.example` 复制一份
> （`docker-compose.yml` 通过 `env_file` 引用它，缺文件会直接启动失败）。复制后请把
> `SESSION_SECRET` 改成随机强值；`ADMIN_TOKEN` 留空即可 —— 管理员 Token 由安装向导生成。

访问 `https://<你的域名>`（或本机 `http://127.0.0.1:8081`，端口跟随 `.env` 的 `PORT`）。未安装时任何页面都会 307 跳到 `/install`。

> **安装入口**：与 komari 一致，安装向导**不限制来源 IP**——公网域名（Nginx 反代）、
> 局域网、本机直连都能打开 `/install` 并完成初始化。排他性由「未安装窗口 + 内存状态机 +
> 哈希锁」保证：装完后向导立刻锁定，`POST /api/install/complete` 返回 409/410。
> 因此建议装完马上确认能登录；若不希望安装页在公网可达，可在 Nginx 层对 `/install`
> 与 `/api/install` 临时加 IP 白名单或 Basic Auth（应用层不再做闸）。
> 提交安装要求 HTTPS（管理员 Token 只在响应里回显一次）：请用域名 + 证书访问，或
> `ssh -L 8081:127.0.0.1:8081 <user>@<服务器>` 后开 `http://127.0.0.1:8081/install`；
> 明文 `http://<IP>:8081` 能打开向导，但提交时会被 403（`https required`）。

在向导里填写站点名称 / 描述 / **上报地址**，并生成管理员 Token（**只显示一次**，请立即保存）。
Token 在库中只存 sha256 哈希，丢了只能用 `sudo bash diting.sh --reset-admin-token` 重置。

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
# 下载统一安装脚本后执行（推荐，参数与后台生成的一致）
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/diting.sh -o diting.sh
chmod +x diting.sh
sudo ./diting.sh --install-agent --server https://<你的域名> --id <ID> --token <Token>
```

安装的是 **Go 单二进制**受控端（零依赖，约 5MB）。也可直接用 `agent-go/install.sh`：

```bash
sudo bash agent-go/install.sh --server https://<你的域名> --id <ID> --token <Token>
```

### Windows

以**管理员**身份运行 PowerShell，执行后台「添加 Agent」生成的 Windows 一键命令
（内部为 `agent-go/install-go.ps1`：下载 `diting-agent.exe` + SHA256 校验 + 注册计划任务）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "`$p=Join-Path `$env:TEMP 'diting-go-install.ps1'; iwr 'https://raw.githubusercontent.com/fengzone85/diting/master/agent-go/install-go.ps1' -OutFile `$p -UseBasicParsing; & `$p -RepoBase 'https://github.com/fengzone85/diting/releases/latest/download' -ServerUrl 'https://<你的域名>' -AgentId '<ID>' -AgentToken '<Token>' -Interval 20"
```

## 数据管理

### 数据保留

服务端每小时自动清理过期指标。默认保留 30 天，可在「设置 → 站点与界面」调整（7-3650 天），也可通过环境变量 `RETENTION_DAYS` 设置。

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
