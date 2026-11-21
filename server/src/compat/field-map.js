'use strict';
// 兼容层字段映射单一事实源（H-1）。
//
// 背景：diting metrics 列在预览版的三个兼容出口（REST / JSON-RPC / metrics）里
// 各有一套对外命名。历史上 swap 错映射、load_type 投影漏列等「改一处漏三处」，
// 根因都是同一组列名散落在 compat*.js。本文件是唯一允许出现「diting 指标列名 ↔
// 兼容字段名」映射的地方；compat.js / compat-rpc.js / compat-metrics.js 只引用这里。
//
// 注意：响应信封键（status/message/data、task_id/time/value 等）与 probes JSON 键
// 不是 diting 指标列映射，仍留在各端点内联。

// ── 1. 扁平记录字段（参考面板 flatRecord）──
// 键 = 兼容扁平字段；值 = diting metrics 列。顺序即 common:getRecords(type=load)
// 与 common:getNodeRecentStatus 的输出顺序。
const LOAD_FIELD_MAP = {
  cpu: 'cpu',
  ram: 'mem_used',
  ram_total: 'mem_total',
  swap: 'swap_used',
  swap_total: 'swap_total',
  load: 'load1',
  temp: 'temp',
  disk: 'disk_used',
  disk_total: 'disk_total',
  net_in: 'net_rx_rate',
  net_out: 'net_tx_rate',
  net_total_up: 'net_tx_month',
  net_total_down: 'net_rx_month',
  process: 'process_count',
  uptime: 'uptime'
};

// REST /api/records/load 的记录字段顺序：与扁平记录不同（temp 在流量之后，且不含 uptime）。
const REST_LOAD_RECORD_ORDER = [
  'cpu', 'ram', 'ram_total', 'swap', 'swap_total', 'load',
  'disk', 'disk_total', 'net_in', 'net_out', 'net_total_up', 'net_total_down',
  'temp', 'process'
];

// getNodesLatestStatus 的扁平状态字段（比 LOAD_FIELD_MAP 多 load5/load15，
// 且需要 gpu/connections/connections_udp 占位）。值为 null 表示固定输出 0。
const LATEST_STATUS_FIELDS = [
  ['cpu', 'cpu'],
  ['gpu', null],
  ['ram', 'mem_used'],
  ['ram_total', 'mem_total'],
  ['swap', 'swap_used'],
  ['swap_total', 'swap_total'],
  ['load', 'load1'],
  ['load5', 'load5'],
  ['load15', 'load15'],
  ['temp', 'temp'],
  ['disk', 'disk_used'],
  ['disk_total', 'disk_total'],
  ['net_in', 'net_rx_rate'],
  ['net_out', 'net_tx_rate'],
  ['net_total_up', 'net_tx_month'],
  ['net_total_down', 'net_rx_month'],
  ['process', 'process_count'],
  ['connections', null],
  ['connections_udp', null]
];

// ── 2. 上游点分指标名 → diting 列 ──
// 合并原先 compat-metrics 的 METRIC_FIELD_MAP 与 compat-rpc 的 RECORD_FIELD_MAP。
// 只保留 diting 真实采集的列：GPU / connections 不映射（宁可缺图，不可错值）。
const POINT_FIELD_MAP = {
  'cpu.usage': 'cpu',
  'process.count': 'process_count',
  'load.average': 'load1',
  'load.5': 'load5',
  'load.15': 'load15',
  'memory.used': 'mem_used',
  'memory.total': 'mem_total',
  'ram.used': 'mem_used',
  'ram.total': 'mem_total',
  'swap.used': 'swap_used',
  'swap.total': 'swap_total',
  'disk.used': 'disk_used',
  'disk.total': 'disk_total',
  'net.in.rate': 'net_rx_rate',
  'net.out.rate': 'net_tx_rate',
  'net.total.up': 'net_tx_month',
  'net.total.down': 'net_rx_month',
  'traffic.up': 'net_tx_month',
  'traffic.down': 'net_rx_month',
  uptime: 'uptime',
  temperature: 'temp'
};

// common:getRecords / public:getRecordsByUUID 的 metric_keys 分支保持改造前能力集：
// 不含 process.count（该指标只在 public:queryMetrics / metrics:query 生效）。
const RECORD_FIELD_MAP = Object.fromEntries(
  Object.entries(POINT_FIELD_MAP).filter(([k]) => k !== 'process.count')
);

// ── 3. diting 短命名 → 上游点分名（queryMetrics 反向识别用）──
const METRIC_KEY_TO_POINT = {
  cpu: 'cpu.usage',
  memory: 'memory.used',
  memory_usage: 'memory.usage',
  disk: 'disk.used',
  disk_usage: 'disk.used',
  load: 'load.average',
  net_up: 'net.out.rate',
  net_down: 'net.in.rate',
  traffic_up: 'net.total.up',
  traffic_down: 'net.total.down',
  temperature: 'temperature'
};

// ── 4. load_type 分组（REST 与 RPC 共用同一份字段组）──
// connections 在 REST 侧投影占位 0；RPC 侧 LOAD_FIELD_MAP 无此列，循环时自动跳过。
const LOAD_TYPE_GROUPS = {
  cpu: ['cpu'],
  ram: ['ram', 'ram_total'],
  swap: ['swap', 'swap_total'],
  load: ['load'],
  temp: ['temp'],
  disk: ['disk', 'disk_total'],
  network: ['net_in', 'net_out', 'net_total_up', 'net_total_down'],
  process: ['process'],
  connections: ['connections'],
  gpu: [],
  all: Object.keys(LOAD_FIELD_MAP)
};

// REST /api/records/load 的官方白名单：不含 gpu/all（改造前 hasOwnProperty 口径）。
const REST_LOAD_TYPES = new Set([
  'cpu', 'ram', 'swap', 'load', 'temp', 'disk', 'network', 'process', 'connections'
]);

// ── 5. /api/recent 嵌套实时结构（toRealtime）──
// [分组名, [[嵌套键, diting 列], ...]]，顺序即输出顺序。
const REALTIME_GROUPS = [
  ['cpu', [['usage', 'cpu']]],
  ['ram', [['total', 'mem_total'], ['used', 'mem_used']]],
  ['swap', [['total', 'swap_total'], ['used', 'swap_used']]],
  ['load', [['load1', 'load1'], ['load5', 'load5'], ['load15', 'load15']]],
  ['disk', [['total', 'disk_total'], ['used', 'disk_used']]],
  ['network', [
    ['up', 'net_tx_rate'],
    ['down', 'net_rx_rate'],
    ['totalUp', 'net_tx_month'],
    ['totalDown', 'net_rx_month']
  ]]
];

// ── 6. /api/node/:uuid 历史序列字段（兼容命名 → diting 列，顺序即输出顺序）──
// 该端点用 up/down（而非 net_out/net_in）与 load1（而非 load），与扁平记录不同。
const NODE_HISTORY_FIELDS = [
  ['cpu', 'cpu'],
  ['ram', 'mem_used'],
  ['ram_total', 'mem_total'],
  ['swap', 'swap_used'],
  ['swap_total', 'swap_total'],
  ['disk', 'disk_used'],
  ['disk_total', 'disk_total'],
  ['up', 'net_tx_rate'],
  ['down', 'net_rx_rate'],
  ['load1', 'load1'],
  ['temp', 'temp']
];

module.exports = {
  LOAD_FIELD_MAP,
  REST_LOAD_RECORD_ORDER,
  LATEST_STATUS_FIELDS,
  POINT_FIELD_MAP,
  RECORD_FIELD_MAP,
  METRIC_KEY_TO_POINT,
  LOAD_TYPE_GROUPS,
  REST_LOAD_TYPES,
  REALTIME_GROUPS,
  NODE_HISTORY_FIELDS
};
