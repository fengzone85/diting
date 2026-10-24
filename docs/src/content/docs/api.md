---
title: API 接口
description: DiTing REST API 参考
---

# API 接口

DiTing 服务端提供 REST API。受控端（Agent）与管理端（浏览器 / 脚本）使用不同的鉴权方式。

## 鉴权

**受控端上报**：请求头携带 `X-Agent-ID: <id>` 与 `Authorization: Bearer <agent_token>`。

**管理接口**：自定义头 `X-Admin-Token: <admin_token>`、`X-Readonly-Token: <readonly_token>` 或 `X-API-Token: <api_token>`，或使用 Web 登录后的签名 Session Cookie（浏览器自动携带）。注意管理端**不解析** `Authorization: Bearer`——该头只用于受控端上报与 `/metrics`。

> 反代后须带 `X-Forwarded-Proto: https`（或本机调试设 `ADMIN_ALLOW_HTTP=1`），否则管理请求返回 `403 https required`。只读身份调用写接口返回 `403 admin required`。

### 三层权限

| 身份 | 来源 | 能力 |
|---|---|---|
| admin | Session Cookie / `X-Admin-Token` / `scope=admin` 的 API Token | 全部读写 |
| readonly | `X-Readonly-Token` / `scope=readonly` 的 API Token | 只读 GET；写接口 `403 admin required` |
| 节点白名单 | **带 `agent_ids`** 的 API Token（admin / readonly 皆可） | 在上述能力之上再收窄到白名单内节点 |

### API Token 作用域（`agent_ids`）

`agent_ids` 为空数组 = 不限节点（等价于旧的只读/管理凭证）；非空时：

- **单节点接口**越权 → `403 forbidden_node`：`GET /agents/:id`、`GET /agents/:id/metrics`、`PUT/DELETE /agents/:id`、`POST /agents/:id/{approve,renew,reset-token}`、`GET /agents/:id/commands`、`PUT/DELETE /admin/alert-rules/agent/:id`、`POST /ai/analyze-node/:id`、`GET /ai/node-reports?agent_id=`；
- **全局聚合面** → `403 forbidden_scope`：`GET /overview`、`GET /agents/sparklines/overview`、`GET /billing`、`GET /admin/alert-rules`、`GET /ai/usage`、`GET /ai/reports`、`GET /ai/reports/:id`、`GET /admin/audit-logs`，以及 Token 管理端点自身；
- **全局配置 / 基础设施写接口**同样 `403 forbidden_scope`：`POST /agents`、`PUT /settings`、`POST /test-alert`、`PUT /ai/config`、`POST /ai/run`、通知渠道与通知组的增删改与测试、`PUT/DELETE /admin/alert-rules/group/:grp`、备份下载/删除/恢复、`/admin/2fa/*`、`POST /public/order`。理由：受限 Token 的授权范围是「这几个节点」，与节点无关的全局变更（关掉全站告警、改系统设置、重建 2FA）必须拒绝；
- `GET /agents` 与 `GET /agents/sparklines` 按白名单**过滤**而非拒绝，只返回自己的节点。

> 受限 Token 不能调用 `/admin/api-tokens`，否则可签发一个 `agent_ids=[]` 的 Token 绕过节点边界（提权路径已封）。

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

> 字段以 `agent-go/collector/` 实际输出为准；响应体仅用于错误日志，Agent **从不解析、从不执行**。

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
| DELETE | `/api/agents/:id` | 删除节点（软删：7 天缓冲，期间可恢复） |
| GET | `/api/agents/deleted` | 最近删除（软删节点 + 剩余天数） |
| POST | `/api/agents/:id/restore` | 恢复软删节点（7 天缓冲期内） |
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
| GET | `/api/admin/notify/migration-status` | 旧通知配置迁移状态（`banner`=是否提示迁移横幅；`groups_enabled`=通知组路由是否启用） |
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
| GET | `/api/admin/sessions` | 登录会话列表（来源 IP / UA / 当前设备标记；仅全局作用域管理员，节点白名单 Token 返回 403） |
| DELETE | `/api/admin/sessions/:id` | 踢出单个会话（立即生效，被踢设备下一次请求即 401） |
| POST | `/api/admin/sessions/revoke-all` | 批量注销（body `{ keep_current?: boolean }`，默认保留当前会话；`false` 为全局吊销） |
| GET | `/api/setup/status` | 初始化向导状态 |
| POST | `/api/setup/generate` | 首次访问生成管理员 Token（独立限流） |
| POST | `/api/setup/register` | 受控端自助注册（需 `SETUP_TOKEN`，独立限流） |
| GET | `/api/admin/backups` | 备份文件列表（含 `integrity` 三态、`restore_audit` 最近一次恢复审查报告；只读角色不返回报告） |
| GET | `/api/admin/restore-audit` | 最近一次恢复审查报告（后台顶部黄条数据源；含 retention 最早/最晚与分批次） |
| GET | `/api/admin/backups/:name/download` | 下载指定备份 |
| DELETE | `/api/admin/backups/:name` | 删除指定备份 |
| POST | `/api/admin/backups/:name/restore` | 请求宿主侧恢复（提交前对 `.db` 做 10s `integrity_check`，失败 400；由 cron 每 5 分钟消费；发起者随请求文件写入，恢复后由脚本补记 `restore_backup` / `restore_completed` 审计） |
| GET | `/api/admin/backup-status` | 备份配置与备份监控状态 |
| GET | `/api/admin/audit-logs` | 管理员操作审计日志 |
| GET | `/api/admin/2fa/status` | 2FA 状态 |
| POST | `/api/admin/2fa/setup` `/enable` `/disable` | 绑定 / 启用 / 关闭 2FA |
| GET / POST | `/api/admin/api-tokens` | API Token 列表（脱敏，无明文/哈希）/ 签发 |
| DELETE | `/api/admin/api-tokens/:id` | 吊销 API Token（下一次请求即刻失效） |

### 签发 / 吊销 API Token

后台侧边栏「API Token」页可直接完成签发与吊销（明文一次性展示、支持复制），下列接口是该页面对应的 HTTP 形式。

```http
POST /api/admin/api-tokens
X-Admin-Token: <admin_token>
Content-Type: application/json

{
  "name": "panel-viewer",
  "scope": "readonly",
  "agent_ids": ["agt_aedf907909b1"],
  "expires_in_days": 90
}
```

```json
{
  "id": "tok_1a2b3c4d5e6f",
  "name": "panel-viewer",
  "scope": "readonly",
  "agent_ids": ["agt_aedf907909b1"],
  "expires_at": 1793000000000,
  "token": "diting_<48hex>",
  "notice": "明文只返回这一次，请立即保存；丢失只能吊销后重建"
}
```

- `token` 明文**只在创建响应中出现一次**，服务端仅存 SHA-256；列表中不会回显。
- `scope` 缺省为 `readonly`（最小权限）；非法值 `400 invalid_scope`。
- `agent_ids` 须为**已存在节点**的 id（未知 id → `400 unknown_agent_id`），最多 500 个。
- `expires_in_days` 为 1–3650 的整数，缺省 / 0 表示永不过期；越界或非整数 → `400 invalid_expires_in_days`。
- 吊销：`DELETE /api/admin/api-tokens/:id`，返回 `200 {ok,id}`；不存在或已吊销返回 `404`。
- Token 管理端点仅 admin 可用；调用方自身若是受限 Token（`agent_ids` 非空）→ `403 forbidden_scope`。

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
- **登录 `/api/login` 另有指数封禁**（F9）：连续失败 3 次起按「失败次数 ^ 4」秒封禁（3 次 → 81 秒，上限 24 小时），封禁期返回 `429` + `Retry-After` 响应头（响应体 `error=login_blocked` + `retry_after` 秒数）；成功登录即清零。计数维度为来源 IP，状态在内存中（重启服务即解除）。详见[安全设计 → 登录暴力防护](security.md#登录暴力防护f9)
