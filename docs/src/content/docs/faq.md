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
