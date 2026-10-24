# 谛听（diting）双容器测试结果交叉审查与修复方案

- 审查对象：另一容器提交的《diting-测试与缺陷报告》（452 行）、《diting-bugfix-by-file.md》（459 行 / 10 个补丁块）、《diting-bugfix-markdown.md》、2 个复现脚本
- 审查基线：`48ee69c`（与对方完全一致）
- 审查环境：Node v24.1.0、npm 11.4.2、Go 1.25.1，无 Docker
- 交付物：
  - 本报告
  - [`diting-fix-merged.patch`](file:///workspace/review-2026-10-24/diting-fix-merged.patch) —— 合并后的修复补丁（13 个文件，623 行 diff，可直接 `git apply`）
  - [`verify-online-and-settings.js`](file:///workspace/review-2026-10-24/verify-online-and-settings.js) —— 验收脚本（四方对比，见附录 A）

---

## 0. 结论摘要

| 维度 | 结论 |
| --- | --- |
| 对方缺陷清单 | 12 条中 **11 条根因完全成立**；1 条（BUG-6）根因成立但**影响被夸大**（默认注销已服务端吊销会话） |
| 对方补丁 | 可干净应用（10/10 块），补丁后 **464/464 服务端用例通过、Go 全绿**（我已复跑确认，非引用其自述） |
| 补丁引入的新问题 | **3 个**：① map 型配置无法清空（功能回归）② 默认值固化进库并覆盖 env（会导致历史数据提前被 prune）③ 批量公开接口 N+1 查库 |
| 补丁漏修 | **2 处**：`/metrics` 仍是第 6 个独立在线判定入口；AI 日报仍用全局阈值，忽略节点/分组覆盖 |
| 两份报告关系 | **互补**，仅 BUG-3 重叠（= 我方隐患 5）；对方聚焦"多入口一致性/默认配置/跨平台采集"，我方聚焦"敏感字段泄露/权限边界" |
| 合并修复 | 以对方补丁为骨架，修正 4 处（合并基座、合并策略、/metrics、AI 摘要）后可直接合入；BUG-4/5/6/7/10 原样合入 |

**一句话**：对方的测试方法论和绝大多数结论可信，补丁方向正确、但"深合并"的落地方式有两个会真正伤害线上数据的缺陷，必须修正后再合；同时它把在线判定的"第 6 个入口 `/metrics`"漏掉了，导致它自己提出的 CI lint 会拦住自己的补丁。

---

## 1. 审查方法与限制

### 1.1 实际执行（不是纸面复核）

| 动作 | 结果 |
| --- | --- |
| `git apply --check` 对方补丁 | 10/10 块全部通过，400 行 |
| 在 `48ee69c` 上应用对方补丁后 `npm ci && npm test` | **464 pass / 0 fail**（与其自述一致） |
| 对方补丁后 `go test ./...` | 全绿（collector / config） |
| 对方 2 个复现脚本在**基线**与**补丁后**分别运行 | BUG-1：5 个入口从 `false/true/1/true/true` → 全部 `false`；BUG-2：通知从 `[offline]` → `[]` |
| 在合并补丁上再跑 `npm test` / `go test` | **464 pass / 0 fail**；Go 全绿 |
| `node --check` 全部改动 JS | 通过 |

### 1.2 未能执行的部分（如实说明）

- **前端 103 个用例无法复跑**：本容器 `server/web/node_modules` 缺失（`vitest` 未安装）。对方 BUG-10 的根因（`vitest.config.ts` 全局 `environment: 'jsdom'`，而 `coverage.test.ts` 首行缺 `// @vitest-environment node`）已静态确认成立，补丁写法正确。
- **BUG-4 / BUG-9 无法真实复现**：本容器 `/proc/diskstats` 的 `pmem0` 与 `pmem0p1` 计数全为 0，且无 Docker，无法构造"分区/整盘重复累加"和"veth/docker0 重复计流量"。仅验证了代码路径与 sysfs 判定逻辑（本机 `pmem0p1` 确实带 `/partition` 标记，会被新代码跳过）。
- **BUG-6 的"注销失效"无法在本机复现**：原因见第 4 节——默认注销会吊销服务端会话，旧 Cookie 已无实际权限。

---

## 2. 对方 12 条结论逐条复核

判定口径：**成立** = 根因代码与影响描述均可复现/可静态证实；**影响夸大** = 根因成立但严重度或现象描述不准确。

| # | 对方标题 | 我的判定 | 复核要点（行号为基线 48ee69c） |
| --- | --- | --- | --- |
| BUG-1 | 在线状态多源判定 | **成立**，另漏 2 处 | `/api/agents` 走三级阈值，`/api/agents/:id`、`/overview`、`/public/*`、`/api/v1/*`、`/api/compat` 直读 env。补丁替换后 5 个入口实测一致（附录 A-1） |
| BUG-2 | 新建节点立即告警 | **成立** | [alerts.js](file:///workspace/server/src/alerts.js#L89) `a.last_seen && ...`，`last_seen=0` 落入离线分支；复现脚本 base 触发 `offline`，补丁后 `[]` |
| BUG-3 | 局部 PUT 清空全站设置 | **成立**（我方隐患 5 同源） | [api.js](file:///workspace/server/src/api.js#L1537) `db.setUiSettings(b.ui)` 全量覆盖；实测只提交 `{alert:{offline_sec:45}}` 后 `agent_server_url` 丢失（附录 A-2 base 列） |
| BUG-4 | 分区/整盘重复累加 | **成立**（结构验证） | [diskio.go](file:///workspace/agent-go/collector/diskio.go#L42-L46) 只过滤 `ram/loop/zram/dm-/md`；分区行会再累加一遍 |
| BUG-5 | uint64 下溢尖刺 | **成立** | [linux.go](file:///workspace/agent-go/collector/linux.go#L105-L111) 磁盘分支无单调性保护，而网络分支 L91-L96 有 |
| BUG-6 | HTTP 部署下注销无效 | **根因成立，影响夸大** | `clearSessionCookie` 固定带 `Secure` 而 `setSessionCookie` 在 `ADMIN_ALLOW_HTTP=1` 时不带，二者属性不一致属实；但默认注销同时 `revokeAllSessions()`，旧 Cookie 会被 `verifySession` 拒绝。详见第 4 节 |
| BUG-7 | 轮询忽略覆盖值 | **成立** | [alerts.js](file:///workspace/server/src/alerts.js#L317-L322) 只用全局 `offline_sec` 推导间隔；补丁取全局与所有覆盖值的最小值，正确（热更新仍需重启，其报告已注明） |
| BUG-8 | 60s + 60s 零余量 | **成立** | [config.go](file:///workspace/agent-go/config/config.go#L87) `SLOW_INTERVAL` 默认 60；[.env.example](file:///workspace/server/.env.example#L34)、[README](file:///workspace/README.md#L213) 默认 60，而 [README](file:///workspace/README.md#L411) 要求 `≥120`；另 **[docker-compose.yml](file:///workspace/server/docker-compose.yml#L41) 也是 60（对方漏列）** |
| BUG-9 | 网卡聚合重复计流量 | **成立**（仅代码路径） | [network.go](file:///workspace/agent-go/collector/network.go#L30-L54) 只跳过 `lo`，`docker0/veth*/br-*` 全部累加 |
| BUG-10 | i18n 测试 jsdom 必红 | **成立** | `vitest.config.ts` 全局 jsdom，`coverage.test.ts` 首行无 `@vitest-environment node`，`node:fs` 报错 |
| BUG-11 | `public_enabled` 类型不安全 | **成立** | api 用 `=== false`（4 处），v1/compat 用 `!== false`（[v1.js](file:///workspace/server/src/v1.js#L93-L96)、[compat.js](file:///workspace/server/src/compat.js#L145-L148)），字符串 `"no"` 关不掉公开页 |
| BUG-12 | 计费 UTC / 续期本地日界 | **成立** | [billing.js](file:///workspace/server/src/billing.js#L15-L18) 用 `Date.UTC(...)`，[renew.js](file:///workspace/server/src/renew.js#L2-L7) 明确本地日历日 |

补充：对方 BUG-4 的证据表省略了部分设备（`...`），导致"按现有口径合计"与表格前三行对不上；比值 1.83 倍（71,985,264 / 39,388,416）本身自洽。建议报告里贴完整 `/proc/diskstats` 片段，便于第三方复核。

---

## 3. 对方补丁评审

### 3.1 逐块评审

| 补丁块 | 文件 | 结论 | 说明 |
| --- | --- | --- | --- |
| 1 | `server/src/online.js`（新增） | ✅ 正确 | 唯一真源，无循环依赖（`db`/`alerts` 都不回引 `online`，已核实）；`isOnline` 对 `last_seen=0` 返回 false 与旧 api 行为一致 |
| 2 | `server/src/api.js`（4 处在线判定） | ✅ 正确 | 替换后仅剩 `/metrics` 一处未改（见 3.3） |
| 3 | `server/src/api.js`（PUT /settings 深合并） | ⚠️ **需修正** | 方向对，落地方式有两个硬伤（见 3.2） |
| 4 | `server/src/alerts.js`（checkAgent） | ✅ 正确 | `if (!a.last_seen) return null`；不影响指标类告警（无数据本就不判定）。补丁注释写"BUG-4"实为 BUG-7，文档瑕疵 |
| 5 | `server/src/alerts.js`（start 间隔） | ✅ 正确 | 取覆盖最小值；`10000` 下限保留。补丁注释编号与表格错位 |
| 6 | `server/src/auth.js`（Cookie 属性统一） | ✅ 正确且无副作用 | 全仓 `Set-Cookie` 仅此 2 处（auth.js:151/155），已全覆盖 |
| 7 | `agent-go/collector/diskio.go` | ✅ 正确 | sysfs 判定分区；容器内无 `/sys` 时退化为旧行为（应补文档说明） |
| 8 | `agent-go/collector/linux.go` | ✅ 正确 | 与网络分支对齐；重置点速率为 0 是合理降级 |
| 9 | `agent-go/collector/diskio_test.go`（新增） | ⚠️ 有抖动风险 | 先采样再重扫 `/proc/diskstats`，忙时计数增长会假失败；且测试用 `len(fs) < 14` 而被测代码用 `< 11`，老内核上会不一致 |
| 10 | `web/src/utils/i18n/coverage.test.ts` | ✅ 正确 | 本容器缺 vitest，未复跑 |

### 3.2 补丁引入的三个新问题（已用三方对比实测）

三方对比：**base**（48ee69c）/ **dpatch**（对方补丁原样）/ **dfix**（对方补丁 + 本次增补）。完整输出见附录 A-2。

#### ① P1：map 型配置再也删不掉（功能回归）

`mergeUiSettings` 对所有普通对象递归合并，而 `custom_tags` / `provider_aliases` 是"用户整包提交的 map"。实测：

```
dpatch：清空 custom_tags({}) 后 → {"a":"x","b":"y"}   ← 旧值复活
dpatch：删单个 tag              → {"a":"x","b":"y"}   ← 删不掉
dfix  ：清空 custom_tags({}) 后 → {}                  ← 正常
```

调用链是实的：模板页把表单整包提交（[TemplateView.vue](file:///workspace/server/web/src/views/admin/TemplateView.vue#L247-L256)），用户清空 JSON 文本域后 `custom_tags = {}`，服务端深合并把旧值全部合并回来，前端仍提示"已保存"。这是从"能删"退化成"删不掉"，属于静默功能回归。

#### ② P2：默认值被固化，反过来覆盖环境变量（会缩短数据保留期）

对方用 `uiBefore = db.getUiSettings()` 做合并基座，而这个函数返回的是**填满默认值**的视图。一次局部提交就会把 34 个默认键全部写库。实测：

```
dpatch：落库键数 1 → 34，retention_days=30 被写入
        getRetentionDays()：env 90 → 30      ← RETENTION_DAYS 失效
        prune 任务（server.js）随后按 30 天删历史指标
dfix  ：落库键数 1 → 2（仅 alert），retention_days 未写入
        getRetentionDays()：90（env 生效）
```

同类影响：`alert.cpu_pct=90` 被固化后 `ALERT_CPU_PCT` 失效；`agent_server_url` 等字段也会被"顺手写一遍"。**这不是显示问题，是数据被提前删除**，因此必须修。

#### ③ P2：批量公开接口 N+1 查库

`v1.js` / `compat.js` 的 `isOnline(a)` 未传 `ctx`，每次调用都重新 `resolveAlertThresholds()` → 读 settings + `JSON.parse` + 查分组覆盖 + 查节点覆盖。`compat.toNode` 还同时调 `isOnline` 与 `onlineTtl`（各解析一次）。

- `/api/v1/nodes` 是**未认证**公开端点：500 节点 ≈ 1500+ 次查询 + 500 次 settings 解析；改前为 **0** 次。
- `/api/clients`（WS 快照）同理，且更频繁。

本次增补在 `snapshot()`、`getNodesLatestStatus()`、`/api/v1/nodes`、`/api/nodes` 循环前统一 `buildCtx()` 并透传，消除放大。

### 3.3 补丁遗漏（2 处同源判定）

1. **`/metrics` 是第 6 个入口**：[server.js](file:///workspace/server/server.js#L240-L248) 仍读 `process.env.OFFLINE_THRESHOLD_SEC`（且比较符是 `<=`）。实测 base 与 dpatch 的 `monitor_up` 均为 `1`（在线），而看板已判离线；本次增补后为 `0`（附录 A-1/A-2 [A]）。讽刺的是对方结尾建议加 lint"禁止路由直读该 env"——这条规则会把自家补丁拦下来。
2. **AI 日报仍用全局阈值**：[summarizer.js](file:///workspace/server/src/ai/summarizer.js#L180-L188) 与 `summarizeOne()` 用 `db.resolveAlertThresholds()`（全局），节点设了覆盖值时会出现"日报说在线、告警说离线"。实测 dpatch 该节点摘要 `online=true`（应为 false）；本次增补后 `false`（附录 A-2 [D]）。

---

## 4. 唯一误判：BUG-6 的影响被夸大（修法仍应合入）

对方的证据只贴了两条 `Set-Cookie` 头，缺少决定性一步"持旧 Cookie 访问后台"。实际情况：

- [api.js](file:///workspace/server/src/api.js#L1949-L1957)：`POST /api/logout` **默认**调用 `revokeAllSessions()`；
- [auth.js](file:///workspace/server/src/auth.js#L74-L81)：写吊销水位线 + 吊销会话行 + 清会话缓存；
- [auth.js](file:///workspace/server/src/auth.js#L105-L126)：`verifySession` 命中 `isRevoked` / `row.revoked` 即拒绝。

因此默认路径下，即使浏览器留着旧 Cookie，服务端也不再认它——"退出后仍是登录态"不成立。**真正可复现的只有两个边缘路径**：`POST /api/logout?all=0`（仅清当前 Cookie、不吊销），以及吊销写库异常时的 fail-open。

结论：补丁本身正确、无副作用、应合入（Cookie 属性本就应当一致），但严重度从 P2 降为 P3；报告应补"持旧 Cookie 请求 `/api/overview` 返回 401"这一步。

---

## 5. 两份报告的关系：互补而非冲突

| 关注面 | 对方（BUG-1~12） | 我方（隐患 1~7） |
| --- | --- | --- |
| 多入口一致性 | BUG-1、BUG-6、BUG-7 | — |
| 默认配置/跨平台采集 | BUG-4、5、8、9、12 | — |
| 设置写接口语义 | BUG-3 | 隐患 5（**同一问题，双方独立复现**） |
| 敏感字段泄露 | — | 隐患 1（`token_hash` 随 agent 行回传）、隐患 2（webhook 密钥对 readonly 可见） |
| 权限/审计边界 | — | 隐患 3（私有备注默认公开）、隐患 4（API Token 操作者记为 `unknown`） |
| 部署面 | — | 隐患 6（默认绑 `0.0.0.0`）、隐患 7（AI `base_url` 放行内网、`requireProto` 直读原始头） |

合并建议：两个补丁互不冲突，可同批合入；但**必须先修 BUG-3 的落地方式**，否则会把"局部提交清空全站"换成"默认值固化 + 配置删不掉"两个更隐蔽的问题。

---

## 6. 合并修复方案（已落地为补丁）

### 6.1 总体策略

以对方补丁为骨架（保留 8 个正确块），在其上做 4 处修正：

| 修正 | 文件 | 内容 |
| --- | --- | --- |
| M1 | `db.js` + `api.js` | 新增 `getUiSettingsStored()`（原始存储值）；`PUT /settings` 以它为基座，只对 `alert`/`background`/`announcement` 深合并，其余（map、数组、`glass_custom`、`admin_dashboard_layout`）整体替换，显式 `null` 仍可清空 |
| M2 | `server.js` | `/metrics` 改用 `online.buildCtx()` + `online.isOnline()` |
| M3 | `ai/summarizer.js` | 日报逐节点用 `alerts.resolveAgentThresholds(a).offlineSec`；`summarizeOne()` 改用 `alerts.resolveAgentThresholds(agent)` |
| M4 | `v1.js` + `compat.js` | `toNode(a, show, ctx)`；`/api/v1/nodes`、`/api/nodes`、`snapshot()`、`getNodesLatestStatus()` 循环前 `buildCtx()` 并透传 |

核心 diff（定稿版）：

```js
// db.js：局部更新的合并基座必须是「原始存储值」，不能用填满默认值的 getUiSettings()
function getUiSettingsStored() {
  try { return JSON.parse(getConfig(SETTINGS_KEY) || '{}') || {}; } catch (e) { return {}; }
}

// api.js：只对固定 schema 的对象深合并，map / 数组整体替换
const DEEP_MERGE_KEYS = new Set(['alert', 'background', 'announcement']);
function mergeUiSettings(base, patch) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = DEEP_MERGE_KEYS.has(k) && isPlainObject(v) && isPlainObject(out[k])
      ? mergeUiSettings(out[k], v)
      : v;
  }
  return out;
}
db.setUiSettings(mergeUiSettings(db.getUiSettingsStored(), b.ui));
```

```js
// server.js /metrics：与看板、告警同源
const onlineCtx = online.buildCtx();
const up = online.isOnline(a, now, onlineCtx) ? 1 : 0;
```

### 6.2 修复清单与优先级

| 优先级 | 项 | 状态 | 验收方式 |
| --- | --- | --- | --- |
| P0 | BUG-1 + `/metrics` + AI 摘要统一到 `online.js` | ✅ 已入补丁 | 附录 A-1/A-2 [A][D] |
| P0 | BUG-2 从未上报不告警 | ✅ 已入补丁 | 复现脚本：`[offline]` → `[]` |
| P0 | BUG-3 局部写入语义（M1 修正版） | ✅ 已入补丁 | 附录 A-2 [B][C] 四项 PASS |
| P0 | BUG-4 / BUG-5 采集侧 | ✅ 已入补丁 | `go test ./...` |
| P1 | BUG-6 Cookie 属性（严重度降为 P3） | ✅ 已入补丁 | 检查两条 Set-Cookie 属性一致 |
| P1 | BUG-7 轮询间隔 | ✅ 已入补丁 | 覆盖值 < 全局值时 10s 下限生效 |
| P1 | N+1 覆盖表查询 | ✅ 已入补丁 | 代码审查（ctx 透传） |
| P2 | BUG-10 i18n 测试环境 | ✅ 已入补丁 | 需在装有 web 依赖的环境复跑（本容器不具备） |
| P2 | BUG-8 默认阈值统一 | ⏸ 待决策 | 见 6.4，需同时改 5 处 |
| P3 | BUG-9 流量口径 | ⏸ 待决策 | 需先定"物理网卡视角"还是"容器视角" |
| P3 | BUG-11 `public_enabled` 宽松解析 | ⏸ 待决策 | 建议统一 `!== false` 并补测试 |
| P3 | BUG-12 日界口径 | ⏸ 待决策 | 产品口径问题，非 bug |
| 独立 PR | 我方隐患 1~4、6、7 | ⏸ 不在本补丁 | 涉及脱敏与权限边界，建议单独提交并配测试 |

### 6.3 BUG-8（若采纳"默认改 120s"）必须同步的 5 处

只改一处会继续矛盾：

1. `server/.env.example:34` → `OFFLINE_THRESHOLD_SEC=120`
2. `README.md:213`（默认值说明）
3. `server/docker-compose.yml:41`（`${OFFLINE_THRESHOLD_SEC:-60}` → `120`）
4. `server/src/db.js`：`getUiSettings()` 的 `def.alert.offline_sec` 与 `resolveAlertThresholds()` 的兜底默认
5. `server/test/security-fixes.test.js:58` 中硬编码的"回退 60"断言（对方已提示，但没列具体行）

### 6.4 回归测试计划（建议随后补，本补丁未含）

1. **在线一致性**：UI `offline_sec=10` / env 60 / `last_seen=now-20s`，断言 `/api/agents`、`/api/agents/:id`、`/api/overview`、`/api/public/agents`、`/api/v1/nodes`、`/api/nodes`、`/metrics` 七个入口一致；
2. **从未上报**：新建节点调 `alerts.checkAgent`，断言 `notify.sendEvent` 未被调用；
3. **局部写入**：只提交 `{ui:{alert:{offline_sec:45}}}`，断言 `agent_server_url` 保留、落库不出现 `retention_days`、`getRetentionDays()` 仍等于 env；
4. **map 清空**：先写 `custom_tags={a,b}` 再提交 `{}`，断言落库为 `{}`；
5. **CI lint**：扫描 `server/src`、`server/server.js`，禁止 `process.env.OFFLINE_THRESHOLD_SEC` 出现在路由层（白名单：`db.js` 的默认值解析）。

### 6.5 仍建议修、但不宜混在本补丁里的（我方安全项）

| # | 问题 | 建议 |
| --- | --- | --- |
| 1 | `token_hash` 随 agent 行回传 | `/api/agents`、`/api/agents/:id` 显式字段白名单，禁止 `Object.assign({}, a, ...)` |
| 2 | webhook 密钥对 readonly 可见 | `adminOrReadonly` 接口返回前对 `config` 打码（已有 `safeNotify` 模式） |
| 3 | 私有备注默认公开 | `public_show_business` 默认改为 `false`（或备注单独开关） |
| 4 | 审计 operator=`unknown` | `auth.js` 的 `via` 判断补 `api_token` 分支并记录 token 名 |
| 6 | 默认绑 `0.0.0.0` | `app.listen(PORT, process.env.BIND_HOST || '127.0.0.1')` |
| 7 | AI `base_url` 放行内网 | 复用 SSRF 的"DNS 钉 IP + 私网拒绝"；`requireProto` 改用 `req.protocol` |

---

## 7. 补丁使用说明

```bash
git worktree add --detach /tmp/v 48ee69c
cd /tmp/v
git apply --check /workspace/review-2026-10-24/diting-fix-merged.patch && git apply "$_"

cd server && npm ci && npm test          # 期望 464 pass / 0 fail
cd ../agent-go && go test ./...          # 期望 collector / config 全绿

cd /tmp && REPO=/tmp/v node /workspace/review-2026-10-24/verify-online-and-settings.js
# 期望 [B][A][C][D] 四项均 PASS
```

补丁范围（13 文件 / 623 行 diff）：`agent-go/collector/{diskio.go,diskio_test.go,linux.go}`、`server/server.js`、`server/src/{online.js,api.js,db.js,alerts.js,auth.js,compat.js,v1.js,ai/summarizer.js}`、`server/web/src/utils/i18n/coverage.test.ts`。不含 BUG-8/9/11/12 与我方 6 条安全项。

---

## 附录 A：实测原始输出

### A-1 在线判定一致性（对方复现脚本，`/tmp/repro-online.js`）

```
配置：UI offline_sec=10s / env OFFLINE_THRESHOLD_SEC=60s / last_seen=now-20s

base 48ee69c                        对方补丁后
/api/agents        online=false      /api/agents        online=false
/api/agents/:id    online=true       /api/agents/:id    online=false
/api/overview      online=1          /api/overview      online=0
/api/v1/nodes      online=true       /api/v1/nodes      online=false
/api/public/agents online=true       /api/public/agents online=false
/metrics           monitor_up=1      /metrics           monitor_up=1   ← 补丁漏修
                                     （本次增补后 monitor_up=0）
```

### A-2 三方对比（`verify-online-and-settings.js`）

```
[B] 局部 PUT {ui:{alert:{offline_sec:45}}} 的落库结果
  base   落库键数 1→2，丢失 agent_server_url                 → FAIL 键被清空
  dpatch 落库键数 1→34，retention_days=30，getRetentionDays 90→30
                                                            → FAIL 默认值固化（prune 30 天）
  dfix   落库键数 1→2（仅 alert），retention_days 未写入，90  → PASS

[A] /metrics（env=60s / UI=10s / 20s 未上报）
  base   monitor_up=1   FAIL
  dpatch monitor_up=1   FAIL
  dfix   monitor_up=0   PASS

[C] 清空 custom_tags
  base   {}                  PASS
  dpatch {"a":"x","b":"y"}   FAIL 旧值复活
  dfix   {}                  PASS

[D] AI 摘要跟随节点覆盖（节点覆盖 10s）
  base   全局 60 → online=true    FAIL
  dpatch 全局 10 → online=false   PASS（其补丁未动 AI，此处因全局值被覆盖而"碰巧"正确）
  dfix   全局 10 → online=false   PASS
```

### A-3 复跑统计

```
dpatch：ℹ tests 464  ℹ pass 464  ℹ fail 0   ；go test ./... 全绿
dfix  ：ℹ tests 464  ℹ pass 464  ℹ fail 0   ；go test ./... 全绿
```

### A-4 文件索引（基线行号）

| 问题 | 位置 |
| --- | --- |
| 在线判定 4 入口 | [api.js](file:///workspace/server/src/api.js#L574-L710) |
| 第 6 入口 | [server.js](file:///workspace/server/server.js#L242) |
| PUT 全量覆盖 | [api.js](file:///workspace/server/src/api.js#L1537) |
| 告警 `last_seen=0` | [alerts.js](file:///workspace/server/src/alerts.js#L89) |
| 轮询只看全局 | [alerts.js](file:///workspace/server/src/alerts.js#L317-L322) |
| Cookie 属性不一致 | [auth.js](file:///workspace/server/src/auth.js#L145-L155) |
| 分区重复累加 | [diskio.go](file:///workspace/agent-go/collector/diskio.go#L42-L46) |
| 磁盘速率下溢 | [linux.go](file:///workspace/agent-go/collector/linux.go#L105-L111) |
| 网卡聚合 | [network.go](file:///workspace/agent-go/collector/network.go#L30-L54) |
| 默认阈值矛盾 | [.env.example:34](file:///workspace/server/.env.example#L34)、[README:213](file:///workspace/README.md#L213)、[README:411](file:///workspace/README.md#L411)、[compose:41](file:///workspace/server/docker-compose.yml#L41)、[config.go:87](file:///workspace/agent-go/config/config.go#L87) |
| README 与 env 默认 | 同上 |
| 保留期解析 | [db.js](file:///workspace/server/src/db.js#L1253-L1272) |
| AI 摘要阈值 | [summarizer.js](file:///workspace/server/src/ai/summarizer.js#L180-L188) |
