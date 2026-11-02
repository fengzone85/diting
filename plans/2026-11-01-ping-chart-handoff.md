# 延迟图渲染问题：服务端已修复项与交接说明

> 日期：2026-11-01
> 验证主题：Glassmorphism v3.4.4（Vue）、PurCarte v1.2.5（React）
> 结论：服务端侧已定位并修复 3 项导致「暂无延迟数据」的原因；剩余渲染条件需要主题侧确认

## 1. 现象

启用社区主题后，负载图（6 张）正常渲染，延迟图恒显示「暂无延迟数据」，包括统计卡与曲线。

## 2. 本次修复（2026-11-01）

| 项 | 修复前 | 修复后 |
|---|---|---|
| **task id 口径** | `GET /api/records/ping` 用 1/2/3 顺序 id；RPC 用哈希 id（如 32055）。主题混用两个数据源时永远关联不上 | REST 与 RPC 三处统一走 `probeTaskId(name)`（确定性哈希，同一名称在所有节点得到同一 id） |
| **任务间隔** | RPC 返回 `interval: 0` / `interval_seconds: 0`；REST 返回 `interval: 1`。0 会被当成「无间隔任务」跳过渲染 | 三处统一 `60`（`PROBE_TASK_INTERVAL`，Komari 默认探测周期） |
| **REST 外壳** | 顶层 `{ count, records }` | `{ status, message, data: { count, records, tasks } }` |
| **延迟记录实体过滤**（2026-11-02 补修） | `common:getRecords(type='ping')` 内部走跨全部节点的 `probesAll` 采样且**未按 uuid 过滤**——实测请求 j4125 返回的是 n5100 的探针记录，主题按 client 关联 tasks 时全部落空 | 按 `entityId` 过滤 `records` 与 `stats`，两个实体互不串台 |

## 3. 更早已对齐的项

- **probes 对象格式解析**：diting 入库为 `{ "<目标名>": { ms, ok, loss } }`，此前只认数组格式，导致该接口恒返回 `count: 0`
- **RPC 三方法集合一致**：`public:getPublicPingTasks`、`public:getPingMetricStats`、`public:queryMetrics` 的 task 集合与 id 已对齐
- **queryMetrics 保持信封**：`{ start, end, series }`（Glassmorphism 的 LoadChart 直接读 `o.series`，返回裸数组会让六张负载图全空）

## 4. 真实响应样例（脱敏，agent id 已替换）

### 4.1 `public:getPublicPingTasks`

```json
{"jsonrpc":"2.0","result":{"count":3,"tasks":[
  {"entity_id":"agt_xxx","client":"agt_xxx","id":32055,"task_id":32055,
   "task_name":"移动","name":"移动","type":"icmp","interval_seconds":60,"interval":60},
  {"entity_id":"agt_xxx","client":"agt_xxx","id":744204,"task_id":744204,
   "task_name":"联通","name":"联通","type":"icmp","interval_seconds":60,"interval":60}
]},"id":1}
```

### 4.2 `public:getPingMetricStats`

```json
{"jsonrpc":"2.0","result":{"count":2,"stats":[
  {"entity_id":"agt_xxx","client":"agt_xxx","task_id":32055,"name":"移动",
   "total":6,"valid":6,"loss":0,"loss_approximate":false,
   "interval":60,"interval_seconds":60,"type":"icmp",
   "avg":14.5,"min":12,"max":17,"p50":15,"p99":17,
   "p99_p50_ratio":1.13,"stddev":1.71,"latest":17}
],"tasks":[...],"basic_info":[]},"id":1}
```

### 4.3 `public:queryMetrics`（`metric_keys: ["ping.latency_ms"]`）

```json
{"jsonrpc":"2.0","result":{"start":"2026-11-01T05:55:28.598Z","end":"2026-11-01T06:55:28.598Z",
 "series":[{"metric_key":"ping.latency_ms","entity_id":"agt_xxx","task_id":32055,
   "task_name":"移动","name":"移动","unit":"ms","retention_days":30,"downsampled":false,"count":6,
   "points":[{"time":"2026-11-01T06:50:28.200Z","value":17,"count":1},
             {"time":"2026-11-01T06:51:28.200Z","value":16,"count":1}]}],
 "count":2},"id":1}
```

### 4.4 `GET /api/records/ping?hours=1`

```json
{"status":"success","message":"","data":{
 "count":12,
 "records":[{"task_id":32055,"time":"2026-11-01T06:50:28.200Z","value":17}],
 "tasks":[{"id":32055,"name":"移动","interval":60,"loss":0,"type":"tcp","code":null,"cert_days":null}]
}}
```

## 5. 请主题侧确认的点

1. `PingChart` 中 `latestValues` / `chartData` 的生成条件——是否要求 `stats[*].valid > 0`、`total` 与 `points.length` 相等，或某个字段非空？
2. 是否把 `interval`（秒）当作 x 轴步长或点数估算依据？现为 60。
3. 延迟曲线是按 `series[*].task_id` 关联 `tasks[*].id`，还是按 `task_name`？两者现已一致，任一方式都可用。
4. `loss` 为 0 时是否被误判为空数据（部分实现用 `if (!loss)` 短路）？
5. 数据点为 `{ time, value, count }`，`time` 为 ISO 8601 字符串；是否需要时间戳毫秒数值？

## 6. 复现与验证

```bash
# 1) 确认服务端有探针数据（未配置 PROBE_TARGETS 的实例为空，属正常空态）
curl -s 'https://<host>/api/records/ping?hours=1' | jq '.data.tasks'

# 2) 三处 id 应完全一致
curl -s -X POST 'https://<host>/api/rpc2' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"public:getPublicPingTasks","params":{"entity_id":"<agent_id>"}}' | jq '.result.tasks[].task_id'
curl -s -X POST 'https://<host>/api/rpc2' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"public:getPingMetricStats","params":{"entity_id":"<agent_id>"}}' | jq '.result.stats[].task_id'
```

服务端回归用例：`server/test/komari-theme-compat.test.js` 中的
「延迟任务口径：tasks / stats / series 的 task_id 与 interval 三处一致」与
`server/test/integration.api.test.js` 中的「task id 同源」两条断言。

## 7. 已知限制

- 未配置探测目标（`PROBE_TARGETS`）的实例不会产生 probes 数据，延迟图为空态属于预期
- `interval` 统一上报 60s 是约定值，diting 不建模真实探测周期；若主题需要真实周期，需要受控端补充上报
