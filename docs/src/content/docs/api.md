---
title: API 接口
description: DiTing REST API 参考
---

# API 接口

DiTing 服务端提供 REST API。受控端（Agent）与管理端（浏览器 / 脚本）使用不同的鉴权方式。

## 鉴权

**受控端上报**：请求头携带 `X-Agent-ID: <id>` 与 `Authorization: Bearer <agent_token>`。

**管理接口**：自定义头 `X-Admin-Token: <admin_token>` 或 `X-Readonly-Token: <readonly_token>`，或使用 Web 登录后的签名 Session Cookie（浏览器自动携带）。注意管理端**不解析** `Authorization: Bearer`——该头只用于受控端上报与 `/metrics`。

> 反代后须带 `X-Forwarded-Proto: https`（或本机调试设 `ADMIN_ALLOW_HTTP=1`），否则管理请求返回 `403 https required`。只读 Token 调用写接口返回 `403 admin required`。

## Agent 上报

### POST /api/report

受控端定时上报。Token 存服务端为 SHA-256 哈希，上报负载经 `validateReport` 严格校验，越界 / 格式错误返回 400。

```http
POST /api/report
X-Agent-ID: agt_xxxxxxxx
Authorization: Bearer <agent_token>
Content-Type: application/json

{
  "cpu": 45.2,
  "mem_used": 1234, "mem_total": 8192, "mem_pct": 15.1,
  "disk_used": 71, "disk_total": 100, "disk_pct": 71.0,
  "load1": 0.52, "load5": 0.48, "load15": 0.50,
  "cores": 4,
  "swap_used": 0, "swap_total": 2048, "swap_pct": 0.0,
  "net_rx_rate": 1024, "net_tx_rate": 512, "net_rx_month": 1234567, "net_tx_month": 987654,
  "disk_r_rate": 0, "disk_w_rate": 0,
  "temp": 52.0,
  "uptime": 86400,
  "probes": { "CM": { "ms": 12.3, "ok": true, "loss": 0 } },
  "disks": [ { "mount": "/", "used": 71.0, "total": 100 } ],
  "os": "Debian GNU/Linux 13", "hostname": "srv1"
}
```

> 字段以 `agent/collector.py` / `agent-go/collector/` 实际输出为准；响应体仅用于错误日志，Agent **从不解析、从不执行**。

## 管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 总览统计 |
| GET | `/api/agents` | 所有节点列表 |
| GET | `/api/agents/sparklines` | 批量 Sparkline（首页曲线） |
| GET | `/api/agents/sparklines/overview` | 集群平均 CPU/内存趋势 |
| GET | `/api/agents/:id` | 节点详情 |
| GET | `/api/agents/:id/metrics` | 节点指标时序 |
| POST | `/api/agents` | 创建节点 |
| PUT | `/api/agents/:id` | 编辑节点 |
| DELETE | `/api/agents/:id` | 删除节点 |
| POST | `/api/agents/:id/reset-token` | 重置 Token |
| POST | `/api/agents/:id/renew` | 续期（计费周期顺延） |
| GET | `/api/billing` | 计费总览 |
| GET / PUT | `/api/settings` | 读取 / 保存设置 |
| POST | `/api/test-alert` | 发送测试告警（经通知组路由到全部启用通道） |
| GET | `/api/admin/alert-rules` | 告警阈值总览（全局 / 分组 / 节点覆盖） |
| PUT / DELETE | `/api/admin/alert-rules/agent/:id` | 节点告警覆盖 / 清除覆盖（回退继承） |
| PUT / DELETE | `/api/admin/alert-rules/group/:grp` | 分组告警覆盖 / 清除（`-` 表示未分组默认组） |
| GET / POST | `/api/admin/notify/channels` | 通知渠道列表 / 新建（webhook） |
| PUT / DELETE | `/api/admin/notify/channels/:id` | 修改 / 删除渠道（内置 mail/telegram 配置只读且不可删） |
| POST | `/api/admin/notify/channels/:id/test` | 单渠道测试消息 |
| GET / POST | `/api/admin/notify/groups` | 通知组列表 / 新建 |
| PUT / DELETE | `/api/admin/notify/groups/:id` | 修改 / 删除通知组 |
| GET | `/api/admin/notify/events` | 可订阅事件字典 |
| GET / PUT | `/api/ai/config` | AI 日报配置 |
| POST | `/api/ai/run` | 手动触发 AI 日报（异步任务：`202` 已受理 / `400` 未启用 / `409` 执行中 / `429` 冷却带 `Retry-After`；`?force=1` 跳过冷却） |
| GET | `/api/ai/reports` | AI 日报列表 |
| GET | `/api/ai/reports/:id` | AI 日报详情 |
| GET | `/api/ai/usage` | AI 用量统计 |
| GET | `/api/ai/status` | AI 任务运行状态 |
| POST | `/api/ai/analyze-node/:id` | 单节点 AI 分析 |
| GET | `/api/ai/node-reports` | 节点报告列表 |
| GET | `/api/agents/:id/commands` | 生成该节点的一键安装 / 「修改探测目标」命令（免 Token，凭管理员身份） |
| GET | `/api/client-ip` | 当前请求所见 IP 与反代信任判定（排查白名单 / 限流归属） |
| POST | `/api/login` · POST `/api/logout` | Web 登录 / 登出（签发表态 Cookie） |
| GET | `/api/setup/status` | 初始化向导状态 |
| POST | `/api/setup/generate` | 首次访问生成管理员 Token（独立限流） |
| POST | `/api/setup/register` | 受控端自助注册（需 `SETUP_TOKEN`，独立限流） |
| GET | `/api/admin/backups` | 备份文件列表 |
| GET | `/api/admin/backups/:name/download` | 下载指定备份 |
| DELETE | `/api/admin/backups/:name` | 删除指定备份 |
| POST | `/api/admin/backups/:name/restore` | 请求宿主侧恢复（由 cron 每 5 分钟消费） |
| GET | `/api/admin/backup-status` | 备份配置与备份监控状态 |
| GET | `/api/admin/audit-logs` | 管理员操作审计日志 |
| GET | `/api/admin/2fa/status` | 2FA 状态 |
| POST | `/api/admin/2fa/setup` `/enable` `/disable` | 绑定 / 启用 / 关闭 2FA |

## 公开只读接口（脱敏）

无需 Token，字段脱敏，供公开状态页与第三方主题使用：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/public/overview` | 公开总览 |
| GET | `/api/public/agents` | 公开节点列表（脱敏） |
| GET | `/api/public/agents/sparklines` | 公开 Sparkline |
| GET | `/api/public/agents/:id/probes` | 公开延迟历史 |
| GET | `/api/public/meta` | 站点元信息（logo / 标题） |
| GET | `/api/public/themes` | 可用主题列表 |
| GET | `/api/public/visitor` | 访客 IP / UA（公开页访客计数） |
| POST | `/api/public/order` | 公开页卡片排序保存（需 admin） |

## Komari 主题兼容层

第三方 Komari 皮肤通过 `server/src/compat.js` 接入，端点对齐 Komari 协议：

- REST：`/api/me`、`/api/public`、`/api/version`、`/api/nodes`、`/api/node/:uuid`、`/api/recent/:uuid`、`/api/records/load`、`/api/records/ping`
- 实时：`/api/clients`（WebSocket，任意消息即回推最新 snapshot）、`/api/clients/sse`（SSE）
- RPC2：`/api/rpc2`（POST / WS）
- 标准层：`/api/v1/*`（自研 RESTful 层，响应信封为 `{ code, message, data }`，与皮肤 / 主题协议解耦；适配由独立 adapter 负责）

## Prometheus

### GET /metrics

Prometheus 文本格式，可用于 Grafana。鉴权 `Authorization: Bearer <ADMIN_TOKEN>`（**仅** `ADMIN_TOKEN`，不认 `READONLY_TOKEN`），默认强制 HTTPS（内网直连抓取可设 `ADMIN_ALLOW_HTTP=1`），并受管理端 IP 白名单约束。

```
# HELP monitor_up Agent 是否在线（最近上报在阈值内为 1）
# TYPE monitor_up gauge
monitor_up{agent="agt_xxx",name="web-01"} 1

# HELP monitor_agent_cpu_percent CPU 使用率（百分比）
# TYPE monitor_agent_cpu_percent gauge
monitor_agent_cpu_percent{agent="agt_xxx",name="web-01"} 45.2
monitor_agent_mem_percent{agent="agt_xxx",name="web-01"} 62.8
monitor_agent_disk_percent{agent="agt_xxx",name="web-01"} 71.0
monitor_agent_net_rx_rate_bytes{agent="agt_xxx",name="web-01"} 1024
```

指标前缀统一为 `monitor_`：`monitor_up`、`monitor_agent_cpu_percent`、`monitor_agent_mem_percent`、`monitor_agent_disk_percent`、`monitor_agent_load1/5/15`、`monitor_agent_net_rx_rate_bytes` / `net_tx_rate_bytes`、`monitor_agent_uptime_seconds` 等。

## 限流

- 真实边界在 Nginx `limit_req`（基于 TCP 对端 IP）；应用层限流仅作兜底。`req.ip` 的转发头采信范围由 `TRUST_PROXY` 决定，**默认只信任 loopback**（H-02 收紧）：反代在其它主机 / 容器时必须显式配置 `TRUST_PROXY`，否则 `req.ip` 会算到反代头上；直连场景伪造 `X-Forwarded-For` 不影响 `req.ip`
- 自助注册 `/api/setup/register` 与初始化 `/api/setup/generate` 有独立限流
