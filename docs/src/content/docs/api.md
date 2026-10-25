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
  "probes": { "CM": { "ms": 12.3, "ok": true, "loss": 0 },
              "WEB": { "ms": 118.4, "ok": true, "loss": 0, "type": "http", "code": 200, "cert_days": 63 } },
  "disks": [ { "mount": "/", "used": 71.0, "total": 100 } ],
  "agent_meta": { "version": "1.1.3", "build_sha": "c76d2f2a1b2c3d4",
                  "build_time": "2026-10-19T13:06:32Z", "platform": "linux-amd64" },
  "os": "Debian GNU/Linux 13", "hostname": "srv1"
}
```

> 字段以 `agent-go/collector/` 实际输出为准；响应体仅用于错误日志，Agent **从不解析、从不执行**。
>
> `agent_meta` 是**可选**的构建元信息（描述「这个二进制是怎么来的」，不含任何主机指纹）：
> 老版本受控端不上报该字段，服务端对应列保持为空（= 未知），**不会导致上报被拒**。
> 服务端逐字段清洗：`build_sha` 必须 7–40 位 hex，`build_time` 必须 UTC RFC3339，
> `platform` 必须形如 `linux-amd64`，不合规的一律丢弃为空串。

## 管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 总览统计 |
| GET | `/api/agents` | 所有节点列表 |
| GET | `/api/agents/sparklines` | 批量 Sparkline（首页曲线） |
| GET | `/api/agents/sparklines/overview` | 集群平均 CPU/内存趋势 |
| GET | `/api/agents/:id` | 节点详情 |
| GET | `/api/agents/:id/metrics` | 节点指标时序 |
| GET | `/api/agents/:id/online-history` | 在线时段历史（`?days=30`，返回 daily + outages + uptime_pct） |
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
| PATCH | `/api/agents/:id/traffic` | 手工修正月流量 `{rx,tx}`（字节，至少一项；打当前周期戳） |
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
| POST | `/api/admin/backups` | 应用内一致性快照（`db.backup()` 在线备份，产物 `monitor_*.db`，权限 0600，写 `create_backup` 审计） |
| GET | `/api/admin/restore-audit` | 最近一次恢复审查报告（后台顶部黄条数据源；含 retention 最早/最晚与分批次） |
| GET | `/api/admin/backups/:name/download` | 下载指定备份 |
| DELETE | `/api/admin/backups/:name` | 删除指定备份 |
| POST | `/api/admin/backups/:name/restore` | 请求宿主侧恢复（提交前对 `.db` 做 10s `integrity_check`，失败 400；由 cron 每 5 分钟消费；发起者随请求文件写入，恢复后由脚本补记 `restore_backup` / `restore_completed` 审计） |
| GET | `/api/admin/backup-status` | 备份配置与备份监控状态 |
| GET | `/api/admin/capacity` | 容量保险丝状态（行数/库字节水位、是否暂停历史写入、跳过次数） |
| POST | `/api/admin/capacity/cleanup` | 按当前保留天数清理过期明细并重新评估（写 `capacity_cleanup` 审计） |
| GET | `/api/admin/audit-logs` | 管理员操作审计日志 |
| GET | `/api/admin/agent-versions` | 受控端版本分布汇总 + 每节点版本状态（期望版本对照） |
| PUT | `/api/admin/agent-versions/expected` | 设置 / 清除「期望版本」（全局配置，节点白名单 Token → 403） |
| PUT | `/api/admin/agents/:id/build-tag` | 标注 / 清除单个节点的构建（`custom` 或自由标签，≤32 字符） |
| POST | `/api/admin/agent-artifacts` | 上传自定义受控端二进制（原始 body，见下） |
| GET | `/api/admin/agent-artifacts` | 自定义二进制列表 |
| DELETE | `/api/admin/agent-artifacts/:id` | 删除自定义二进制 |
| POST | `/api/admin/agent-distribution` | 生成分发包（脚本 + 二进制 + 校验和 + manifest）与一次性下载链接 |
| GET | `/api/admin/agent-distribution/:pkg_id/download?t=<token>` | 下载分发包（只认一次性 token，不需管理员凭据） |
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

### 受控端版本可判定性（期望版本对照）

把「节点跑的是哪个版本」从*仅 semver 字符串*升级为*版本 + commit SHA + 构建时间 + 平台 + 与期望版本的差距*。
**只做「看」，不做「推」**：期望版本是对照基准，服务端不会因此向节点下发任何指令。

```http
GET /api/admin/agent-versions
X-Admin-Token: <admin_token>
```

```json
{
  "expected": { "version": "v1.0.9", "sha": "" },
  "counts": { "total": 3, "up_to_date": 2, "outdated": 1, "unknown": 0, "custom": 0 },
  "nodes": [
    { "id": "agt_xxx", "name": "j4125", "online": true,
      "version": "1.0.9", "build_sha": "c76d2f2a1b2c3d4",
      "build_time": "2026-10-19T13:06:32Z", "platform": "linux-amd64",
      "build_tag": "", "status": "up_to_date" }
  ]
}
```

状态判定口径（`server/src/agent-versions.js`）：

| status | 含义 |
|---|---|
| `custom` | 管理员标注了 `build_tag`（`custom` 或自由标签）——人工标注优先于一切自动判定 |
| `up_to_date` | 设了期望且可比对：期望 `sha` 非空 → `build_sha` 相同；否则版本号归一（去 `v` 前缀）后相同 |
| `outdated` | 设了期望且可比对，但不匹配 |
| `unknown` | 未设期望版本，或该节点没有任何可比对的版本信息（**含「期望按 sha 比但节点没有 sha」的老受控端**——宁可说无法判定，也不夸大成落后） |

```http
PUT /api/admin/agent-versions/expected
Content-Type: application/json

{ "version": "v1.0.9", "sha": "" }
```

- `version` ≤32 字符；`sha` 必须 7–40 位 hex，非法值**丢弃**（不报错，避免脏值进库）。
- 两者皆空 = 清除期望（回到「只展示、不对照」，所有节点状态为 `unknown`）。
- 全局配置 → 仅全局作用域管理员可写，节点白名单 Token 返回 `403 forbidden_scope`。

```http
PUT /api/admin/agents/:id/build-tag
Content-Type: application/json

{ "tag": "custom" }
```

- `tag` 允许 `''`（清除）、`custom`、或自由标签（服务端截断到 32 字符）。
- 用途：fork 定制或自行编译的节点标上 `custom` 后不再参与期望版本对照。
- 未知节点 → `404`；越权节点 → `403 forbidden_node`。

三个端点均写审计日志（`agent_expected_version` / `agent_build_tag`）。

### 受控端二进制 artifact 与一键批量分发

服务端只**生成分发物**（脚本 + 二进制 + 校验和 + manifest + README），
**不主动连接节点、不下发指令**——节点上的执行动作始终由管理员发起，
权限面与既有手动升级（`diting.sh --update-agent`）完全一致。

#### 上传自定义二进制

```http
POST /api/admin/agent-artifacts?platform=linux-amd64&source_note=my%20fork%20build
X-Admin-Token: <admin_token>
Content-Type: application/octet-stream

<二进制原始字节>
```

```json
{ "ok": true, "artifact_id": "art_1a2b3c4d5e6f", "sha256": "…64 hex…",
  "platform": "linux-amd64", "size": 8123456, "uploaded_at": 1790000000000, "deduped": false }
```

- 请求体是**原始字节**（不是 multipart）：服务端没有 multipart 解析器，
  零新增依赖；平台与备注走 query 参数。上传时**必须**用非 `application/json` 的
  Content-Type（全局 `express.json` 限 16KB）。
- 平台白名单：`linux-amd64` / `linux-arm64` / `windows-amd64` / `darwin-amd64` / `darwin-arm64`。
- 文件名由服务端按内容哈希生成（`<sha256>.bin` 或 `<sha256>.exe`），
  **不使用任何用户输入**；同内容天然去重（`deduped: true`）。
- 单文件上限 100MB（`AGENT_ARTIFACT_MAX_MB` 可调），超限 `413`。

#### 生成分发包

```http
POST /api/admin/agent-distribution
X-Admin-Token: <admin_token>
Content-Type: application/json

{
  "agent_ids": ["agt_xxx"],
  "target": { "os": "linux", "arch": "amd64" },
  "source": { "kind": "artifact", "artifact_id": "art_1a2b3c4d5e6f" },
  "expires_in_minutes": 30
}
```

```json
{
  "ok": true,
  "pkg_id": "pkg_0123456789abcdef",
  "kind": "tar.gz",
  "download_url": "https://panel.example.com/api/admin/agent-distribution/pkg_0123456789abcdef/download?t=…",
  "one_time_token": "…64 hex…",
  "expires_at": 1790001800000,
  "commands": {
    "linux": "curl -fsSL '…/download?t=…' -o diting-agent-dist.tar.gz && tar xzf diting-agent-dist.tar.gz && sudo sh ./update.sh",
    "windows": "iwr '…/download?t=…' -OutFile diting-agent-dist.zip; Expand-Archive … ; .\\update.ps1"
  },
  "manifest": { "…": "…" }
}
```

- `source.kind`：
  - `artifact` —— 用已上传的二进制（平台必须与 `target` 一致，否则 `400 artifact_platform_mismatch`）；
  - `release_url` —— 服务端下载（走 SSRF 防护：钉 IP / 私网拦截 / 禁 3xx / 体积与超时上限），
    **必须**同时提供 `release_sha256`，不匹配即 `400 release_sha256_mismatch` 并丢弃；
    校验通过后转存为 artifact。
  - `official` —— 从**官方 Release** 取受控端二进制：复用签名中继的取件逻辑
    （**ed25519 验签 + 架构校验 fail closed**），再用官方 release 里的 `<asset>.sha256`
    与**本地计算**的 sha256 做交叉校验；两者不一致即拒绝出包。
    官方资产不可达时返回 `502 official_fetch_failed`，可改用 `release_url` 或先上传 `artifact`。
- 产物：Linux → `tar.gz`（内含 `update.sh`），Windows → `zip`（内含 `update.ps1`）。
- 包内固定含：`update.sh`/`update.ps1`、二进制、`<二进制名>.sha256`、`manifest.json`、`README.txt`。
- Windows 包的 `update.ps1` 以 **UTF-8 BOM** 开头（PowerShell 5.1 会把无 BOM 的 .ps1 按 ANSI 解析，中文注释会导致 ParserError）；
- 脚本红线：**sha256 校验在替换之前**（不匹配立即退出，不动现有二进制）、
  备份为 `diting-agent[.exe].bak-YYYYMMDD-HHMMSS`（带时分秒，同日多次升级互不覆盖）、
  原子替换（写临时文件 + `mv`/`Move-Item`，**不直接覆盖运行中的二进制**——
  Linux 会 ETXTBSY、Windows 会文件锁定）、健康检查失败**自动回滚**；
  **不写** `/etc/diting/agent.env`（Windows 侧**不动** `run_scheduled.bat`）
  ⇒ 节点身份与自定义配置（`AGENT_ID` / `AGENT_TOKEN` / `PROBE_TARGETS` / `MONTH_ROTATE`）原样保留。

#### 面板入口

- **受控端二进制**（`/admin/agent-artifacts`）：上传 / 列表 / 删除自定义二进制
  （内容寻址、同内容去重），供「批量分发」挑选；
- **节点列表 → 批量分发**（选中节点后出现）：选目标平台 + 来源（官方 / 已上传 / 指定 URL）
  → 生成分发包，页面直接给出 Linux / Windows 两条命令与一次性下载链接。
  **命令需管理员在目标节点上以 root / 管理员权限执行**，服务端不主动连接节点。

#### 下载（一次性 token）

```http
GET /api/admin/agent-distribution/:pkg_id/download?t=<one_time_token>
```

- 该端点**不要求管理员凭据**，只认一次性 HMAC 签名 token（密钥由 `SESSION_SECRET` 派生）。
- 默认 30 分钟过期（`expires_in_minutes` 1–1440），**用后即焚**：重放返回 `410 token_used`；
  篡改签名 `403 invalid_token`；过期 `410 expired`；未知包 `404`。
- 响应头：`Content-Type: application/octet-stream`、`Content-Disposition: attachment`、
  `X-Content-Type-Options: nosniff`、固定 `Content-Length`；单 IP 限流 10 次/分钟。
- **绝不要把 `X-Admin-Token` 放进 URL**（URL 会进 shell 历史与 access log）。
  若 nginx 记录了 query，请对 `?t=` 做打码。

## 公开只读接口（脱敏）

无需 Token，字段脱敏，供公开状态页与第三方主题使用：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/public/overview` | 公开总览 |
| GET | `/api/public/agents` | 公开节点列表（脱敏；附带 `uptime_30d` 30 天在线率） |
| GET | `/api/public/agents/sparklines` | 公开 Sparkline |
| GET | `/api/public/agents/:id/probes` | 公开延迟历史；`?availability=1` 附可用率与证书元信息 |
| GET | `/api/public/agents/:id/online-history` | 公开在线时段历史（详情页在线率卡；`?days=30`） |
| GET | `/api/public/meta` | 站点元信息（logo / 标题） |
| GET | `/api/public/themes` | 可用主题列表 |
| GET | `/api/public/visitor` | 访客 IP / UA（公开页访客计数） |
| POST | `/api/public/order` | 公开页卡片排序保存（需 admin） |

`/api/public/agents/:id/probes` 默认返回 `{ "<label>": [{ ts, ms, ok, loss }] }`；
追加 `?availability=1` 时返回 `{ series, availability }`（形状与默认不同，仅新前端使用）：

```json
{
  "series": { "WEB": [{ "ts": 1730000000000, "ms": 118, "ok": true, "loss": 0 }] },
  "availability": {
    "WEB": {
      "up_pct": 99.7, "samples": 1440, "down_samples": 4,
      "avg_ms": 121.3, "max_ms": 890, "last_down_at": 1730000000000,
      "unreachable": false, "type": "http", "code": 200,
      "cert_days": 63, "cert_ts": 1730000000000
    }
  }
}
```

- `up_pct` 分母为窗口内**全部**采样点（`range` 同延迟序列），保留 1 位小数。
- `unreachable=true` 表示窗口内无一成功（目标本身不可达，如运营商 DNS 拒 TCP），前端显示「不可达」而非 0% 可用。
- `cert_days` 是上报时刻的剩余天数；前端展示时按 `cert_ts` 到当前时间衰减。
- 探测三态：正常 `{ms, ok:true, loss}`、不可达 `{ms:null, ok:false, loss:100}`、无采样 `{ms:null, ok:null, loss:null}`（解析超时）；无采样不计入可用率分母，也不会被压成 100% 丢包。
- 探测上报字段：`type`（`http`，缺省 `tcp`，为省体积 tcp 不落库）、`code`（100–599）、`cert_days`（0–3650），非法值单独丢弃而不影响整条结果。

`/api/public/agents/:id/online-history`（F7 在线率）返回：

```json
{
  "days": 30,
  "since": 1730000000000,
  "now": 1732592000000,
  "daily": [{ "date": "2026-10-24", "up_sec": 79200, "pct": 99.9 }],
  "outages": [{ "started_at": 1730000000000, "ended_at": 1730003600000, "duration_sec": 3600 }],
  "uptime_pct": 99.9
}
```

- `daily` 按**主机本地日**切分（跨天 session 拆到两天）；`pct` 的分母是当天已过去的时间，所以今天不会是整天。
- `outages` 只列窗口内的缺口；`ended_at=null` 表示当前仍离线，`duration_sec` 随时间增长。
- `uptime_pct` 的分母从窗口内第一条 session 起算，避免把功能上线前/新节点没数据的时间算成停机；窗口内无 session 时为 `null`。
- 在线时段由 `alerts` 的在线判定派生（不改 agent 协议），保留期与 `RETENTION_DAYS` 一致。

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
