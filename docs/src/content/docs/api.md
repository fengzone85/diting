---
title: API 接口
description: DiTing REST API 参考
---

# API 接口

DiTing 服务端提供 REST API。受控端（Agent）与管理端（浏览器 / 脚本）使用不同的鉴权方式。

## 鉴权

**受控端上报**：请求头携带 `X-Agent-ID: <id>` 与 `Authorization: Bearer <agent_token>`。

**管理接口**：`Authorization: Bearer <admin_token | readonly_token>`，或使用 Web 登录后的签名 Session Cookie（自动携带）。

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
  "mem": { "used": 1234, "total": 8192 },
  "disks": [ { "mount": "/", "used": 71.0, "total": 100 } ],
  "net": { "rx": 1234567, "tx": 987654, "rx_rate": 1024, "tx_rate": 512 },
  "load": { "load1": 0.52, "load5": 0.48, "load15": 0.50 },
  "swap": { "used": 0, "total": 2048 },
  "temp": 52.0,
  "uptime": 86400,
  "probes": [ { "label": "移动", "rtt": 12.3, "loss": 0 } ]
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
| POST | `/api/test-alert` | 发送测试告警 |
| GET / PUT | `/api/ai/config` | AI 日报配置 |
| POST | `/api/ai/run` | 手动触发 AI 日报 |
| GET | `/api/ai/reports` | AI 日报列表 |

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

## Komari 主题兼容层

第三方 Komari 皮肤通过 `server/src/compat.js` 接入，端点对齐 Komari 协议：

- REST：`/api/me`、`/api/public`、`/api/version`、`/api/nodes`、`/api/recent/:uuid`、`/api/records/load`、`/api/records/ping`
- 实时：`/api/clients`（WebSocket，发 `get` 取 snapshot）、`/api/clients/sse`（SSE）
- RPC2：`/api/rpc2`（POST / WS）
- 标准层：`/api/v1/*`（与 Komari 同形，供自研 SPA 复用）

## Prometheus

### GET /metrics

Prometheus 文本格式，可用于 Grafana。鉴权 `Authorization: Bearer <admin_token | readonly_token>`，默认强制 HTTPS。

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

- 真实边界在 Nginx `limit_req`（基于 TCP 对端 IP）；应用层限流仅作兜底，`req.ip` 取自可伪造的 `X-Forwarded-For`，**不作为安全边界**
- 自助注册 `/api/setup/register` 与初始化 `/api/setup/generate` 有独立限流
