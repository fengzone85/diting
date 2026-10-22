---
title: FAQ
description: 常见问题
---

import { Card, CardGrid } from '@astrojs/starlight/components';

# 常见问题

## 部署相关

### Q: 最低配置要求？

**服务端**：512MB 内存 VPS，推荐 1C1G。

**受控端**：
- Docker 形态：需要 Docker Engine，内存 65-150MB
- 原生 systemd 形态：无前置依赖（单文件静态二进制），内存 <10MB

### Q: 支持 ARM / 树莓派吗？

✅ 支持。受控端为 Go 单二进制（linux/amd64、linux/arm64，及 Windows amd64），无架构限制；服务端是 Node.js，同样支持 ARM。

### Q: 可以不用 Docker 吗？

✅ 可以。受控端支持原生 systemd 部署，服务端支持原生 Node.js 部署。

详见 [原生 Linux 部署](/native/)。

### Q: 手动改了 `/opt/diting-src` 里的文件，`--update-server` 之后全被覆盖了？

✅ 这是设计行为，不是 bug。

安装/更新会把源码目录**硬同步**到远端分支（见 `sync_source_ref`）：

```bash
git -C /opt/diting-src fetch origin <REPO_BRANCH>
git -C /opt/diting-src reset --hard FETCH_HEAD   # 丢弃所有本地改动
```

`/opt/diting-src` 由脚本接管，不要在里面直接改代码。按目的选正确做法：

| 想改什么 | 正确做法 |
|---|---|
| 端口 / 密钥 / 开关 | 改 `server/.env`（`.gitignore` 覆盖，不会被同步） |
| 数据库位置 | 改 `DB_PATH`，库文件本身在 `/data` 或 `server/data`，不在覆盖范围 |
| 真的要改代码 | 在仓库里改并推到自己的分支，再用 `REPO_BRANCH=your-branch sudo bash diting.sh --install-server` 安装 |
| 只想临时试一下 | 更新前先 `git -C /opt/diting-src diff > /tmp/my.patch`，更新后 `git apply /tmp/my.patch` |
| 换 apt 镜像源（构建慢） | 用构建参数 `APT_MIRROR`（写进 `.env` 或 `--build-arg`），不要改 `Dockerfile` |

### Q: `--backup` 说成功了，后台「备份」页却看不到文件？

多半是两边指向了不同目录（原生部署常见）：服务端读 `.env` 的 `BACKUP_DIR`，而脚本早期写死
`/var/backups/diting`。

现在脚本按部署形态解析：

| 形态 | 备份目录 |
|---|---|
| Docker（库在命名卷） | 宿主 `/var/backups/diting`（`.env` 里是容器路径 `/data/backups`，靠挂载对齐） |
| 原生（库是宿主文件） | **跟随 `.env` 的 `BACKUP_DIR`**（没有则回落 `/var/backups/diting`） |

排查三步：

```bash
grep '^BACKUP_DIR=' server/.env        # 服务端读哪个目录
sudo bash diting.sh --backup-list      # 脚本用哪个目录；若有旧备份在别处会给出提示
# 后台看到什么（把 <token> 换成管理员 Token）
curl -s -H 'X-Admin-Token: <token>' http://127.0.0.1:8081/api/admin/backups
```

历史备份还在旧目录时：`sudo mv /var/backups/diting/monitor_* "$(grep '^BACKUP_DIR=' server/.env | cut -d= -f2)/"`。

### Q: 数据库用什么？

SQLite 单文件。无需额外安装数据库服务。

## 安全相关

### Q: 为什么没有远程控制功能？

这是设计决策，不是缺失。DiTing 定位为纯状态监控，通过消除指令通道从架构层面杜绝 RCE 风险。

如果需要远程控制，推荐使用哪吒或 Komari。

### Q: Agent 会被利用做 C2 吗？

❌ 不会。DiTing Agent：
- 不监听任何端口
- 不接收任何指令
- 不与其他 Agent 通信
- 仅采集系统状态（无进程列表、无配置、无密钥）

攻击者无法将 DiTing Agent 变为 C2 控制端。

### Q: 忘记 2FA 怎么办？

目前**没有**一键重置 2FA 的开关：`sudo bash diting.sh --reset-admin-token` 只重置 `ADMIN_TOKEN`，
**不影响** 2FA 状态。需 SSH 登录服务器改库关闭后重新绑定：

```sql
-- 库位置：Docker 部署为 diting-server 容器内 /data/monitor.db（DB_PATH 可改）
DELETE FROM admin_config WHERE key IN ('admin_2fa_secret', 'admin_2fa_enabled');
```

重启服务后即可用管理员 Token 登录，再到「设置 → 安全」重新绑定。

### Q: 数据库被偷了怎么办？

- Agent Token 以 SHA-256 哈希存储，非明文
- 立即在服务端重置所有 Token
- 但通知与 AI 凭据（`smtp_pass`、`telegram_bot_token`、AI `api_key`）在库中为**明文**（SQLite 无加密），库泄露等同于泄露这些凭据，须立即轮换

## 使用相关

### Q: 支持告警通知吗？

✅ 支持 QQ 邮箱和 Telegram 告警。在设置中配置通知渠道。

### Q: 可以接入 Grafana 吗？

✅ 可以。服务端提供 `/metrics` Prometheus 格式端点。

### Q: 历史数据保留多久？

默认保留 30 天，可在「设置 → 站点与界面」配置（7–3650 天），也可通过 `RETENTION_DAYS` 环境变量设置。

### Q: 节点离线多久触发告警？

默认 60 秒无上报即判定离线，可通过 `OFFLINE_THRESHOLD_SEC` 环境变量调整。

## 其他

### Q: 和哪吒有什么核心区别？

**核心区别在信任模型**：
- 哪吒：服务端可向 Agent 下发指令（Web 终端、计划任务）
- DiTing：服务端无法向 Agent 下发任何指令


### Q: 支持多用户吗？

当前为单管理员 + 可选只读账号（`READONLY_TOKEN`，仅可读）模式，RBAC 多用户仍在规划中。
