'use strict';
// 第三方主题 JSON-RPC 2.0 网关：为社区主题（如 Glassmorphism）提供查询接口。
// 方法表采用 Map 注册制，预留 plugin:<id>:* 命名空间供未来插件扩展。
const db = require('./db');
const { toNode, toRealtime, publicOpen, getNodesLatestStatus } = require('./compat');
// PROBE_TASK_INTERVAL 与 task id 一样必须三侧同源，统一在 compat-metrics 定义。
const { METRIC_DEFINITIONS, queryMetrics, probeTaskId, PROBE_TASK_INTERVAL } = require('./compat-metrics');
// 审查 C4：RPC 里的重聚合（getPingRecords 720h 全窗）移 worker 线程
const { heavyQuery } = require('./heavy-db');

const METHODS = new Map();

function registerMethod(name, handler) {
  if (METHODS.has(name)) throw new Error(`method ${name} already registered`);
  METHODS.set(name, handler);
}

function getPublicInfo() {
  const ui = db.getUiSettings();
  return {
    cors_origin_check_enabled: false,
    custom_body: '',
    custom_head: '',
    description: '',
    disable_password_login: true,
    oauth_enable: false,
    oauth_provider: '',
    ping_record_preserve_time: 48,
    private_site: false,
    record_enabled: false,
    record_preserve_time: 720,
    sitename: ui.site_title || 'diting',
    theme: ui.public_theme || 'Mochi',
    theme_settings: {}
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(v, max));
}

function getMetricsRange(agentId, { hours = 1, maxPoints = 100 } = {}) {
  hours = clamp(Math.floor(Number(hours) || 0), 0, 720);
  maxPoints = clamp(Math.floor(Number(maxPoints) || 0), 0, 5000);
  const since = Date.now() - hours * 3600 * 1000;
  // M-02：SQL 层均匀采样（保留首尾点），且只取负载列，不再「全量拉取 720h 后 JS filter」
  // 审查 C4：单节点 720h 仍要扫十余万行，移 worker 线程避免阻塞事件循环
  return heavyQuery('loadOne', agentId, since, Math.max(1, maxPoints));
}

async function getProbeRecords({ hours = 1, maxCount = 100, entityId } = {}) {
  hours = clamp(Math.floor(Number(hours) || 0), 0, 720);
  maxCount = clamp(Math.floor(Number(maxCount) || 0), 0, 5000);
  const since = Date.now() - hours * 3600 * 1000;
  const points = Math.max(200, maxCount);
  // 只取 ts+agent_id+probes 三列并按 agent 时间桶降采样（每 agent 最多 maxCount 点），
  // 规避 SELECT * 全表物化 + 330 万行读进内存触发 OOM。probes 周期采样不丢"出现过哪些 task"语义。
  // 审查 C4：跨节点全窗聚合（未认证 RPC 即可触发）移 worker 线程。
  // 指定实体时必须走单节点采样：跨节点 probesAll 的结果还要全局 slice(0, maxCount)，
  // 其它节点的记录排在前面会把目标实体挤空（实测请求 j4125 返回 count=0，全是 n5100 的记录）。
  // Komari 官方同样按 uuid 取该实体记录（web/rpc/jsonrpc/common.record.go:177）。
  const raw = entityId
    ? await heavyQuery('probesOne', entityId, since, points)
    : await heavyQuery('probesAll', since, points);
  const rows = (raw || [])
    .filter(r => r.probes != null)
    .slice(0, maxCount * 10);

  const records = [];
  rows.forEach(r => {
    try {
      const probes = JSON.parse(r.probes || '{}');
      Object.entries(probes).forEach(([name, val]) => {
        records.push({
          // probesOne 只返回 ts+probes，不含 agent_id；实体已知故由调用方补上。
          client: entityId || r.agent_id,
          // task 标识用数字 id（与 series/stats/tasks 三处同源），中文名放 task_name
          task_id: probeTaskId(name),
          task_name: name,
          time: new Date(r.ts).toISOString(),
          value: (val && typeof val.ms === 'number') ? val.ms : -1
        });
      });
    } catch (_) {}
  });
  return records.slice(0, maxCount);
}

// diting 内部字段名 → Komari 点分命名（用于 getRecords 字段映射）
const RECORD_FIELD_MAP = {
  'cpu.usage': 'cpu',
  'load.average': 'load1',
  'load.5': 'load5',
  'load.15': 'load15',
  'memory.used': 'mem_used',
  'memory.total': 'mem_total',
  'ram.used': 'mem_used',
  'ram.total': 'mem_total',
  // swap 此前误指向 mem_used/mem_total（与 compat-metrics 的 L-5 同类问题），主题的
  // swap 曲线会画成内存曲线，此处一并修正。
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
  'uptime': 'uptime',
  'temperature': 'temp'
};

// Komari getRecords(type=load) 的扁平字段名 → diting metrics 列名。
// 主题 LoadChart 按 flatRecord 读取（cpu / ram / ram_total / load / temp / disk / net_in ...）。
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
// load_type → 需要输出的字段组（all = 全部；gpu 不采集，任何分组都不输出）
const LOAD_TYPE_GROUPS = {
  cpu: ['cpu'],
  ram: ['ram', 'ram_total'],
  swap: ['swap', 'swap_total'],
  load: ['load'],
  temp: ['temp'],
  disk: ['disk', 'disk_total'],
  network: ['net_in', 'net_out', 'net_total_up', 'net_total_down'],
  process: ['process'],
  connections: [],
  gpu: [],
  all: Object.keys(LOAD_FIELD_MAP)
};

// 审查 C4：异步化——内部 getProbeRecords/getMetricsRange 的重聚合走 worker 线程
async function getRecords(params = {}) {
  // 兼容前端 LoadChart 实际传参：entity_id + metric_keys + hours + max_points
  // 也兼容旧调用：uuid + type + hours + maxPoints
  const entityId = params.entity_id || params.uuid || (Array.isArray(params.entity_ids) ? params.entity_ids[0] : undefined);
  const hours = clamp(Math.floor(Number(params.hours || params.h || 1) || 0), 0, 720);
  const maxPoints = clamp(Math.floor(Number(params.max_points || params.maxPoints || 100) || 0), 0, 5000);
  const metricKeys = Array.isArray(params.metric_keys) ? params.metric_keys : null;
  const nowIso = new Date().toISOString();
  const fromIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // ping 类型：从 probes 抽延迟
  if (params.type === 'ping' || (metricKeys && metricKeys.some(k => k.startsWith('ping')))) {
    // 实体过滤已下推到 getProbeRecords 的单节点采样（probesOne）：此前「跨节点采样后
    // 再按 client 过滤」会让目标实体的记录先被全局 slice 挤空，最终只剩空数组。
    const records = await getProbeRecords({ hours, maxCount: maxPoints, entityId });
    const byClient = {};
    records.forEach(r => {
      (byClient[r.client] = byClient[r.client] || []).push(r);
    });
    // 按 (client, task_id) 聚合统计，对齐 Komari 社区主题 PingChart 期望的 stats 结构。
    // 前端 Ae() 读 o.value.stats，且只保留 total>0 && !loss_approximate && isFinite(loss) 的 task。
    const agg = {};
    records.forEach(r => {
      const k = r.client + ' ' + r.task_id;
      if (!agg[k]) agg[k] = { entity_id: r.client, task_id: r.task_id, name: r.task_name || String(r.task_id), values: [] };
      const a = agg[k];
      a.total = (a.total || 0) + 1;
      if (typeof r.value === 'number' && r.value >= 0) a.values.push(r.value);
    });
    const stats = Object.values(agg).map(a => {
      const vals = a.values.slice().sort((x, y) => x - y);
      const sum = vals.reduce((s, v) => s + v, 0);
      const avg = vals.length ? sum / vals.length : 0;
      const min = vals.length ? vals[0] : 0;
      const max = vals.length ? vals[vals.length - 1] : 0;
      const p50 = vals.length ? vals[Math.floor(vals.length * 0.5)] : 0;
      const p99 = vals.length ? vals[Math.floor(vals.length * 0.99)] : 0;
      const stddev = vals.length ? Math.sqrt(vals.reduce((s, v) => s + (v - avg) ** 2, 0) / vals.length) : 0;
      const p99_p50_ratio = p50 ? p99 / p50 : 0;
      return {
        entity_id: a.entity_id,
        task_id: a.task_id,
        name: a.name,
        total: a.total,
        valid: vals.length,
        loss: 0,
        loss_approximate: false,
        interval: PROBE_TASK_INTERVAL,
        interval_seconds: PROBE_TASK_INTERVAL,
        type: 'icmp',
        avg, min, max, p50, p99, p99_p50_ratio, stddev,
        latest: vals.length ? vals[vals.length - 1] : 0
      };
    });
    return {
      count: records.length,
      records,
      recordsByClient: byClient,
      stats,
      // Komari 官方 RecordsResp.tasks 除任务清单外还带窗口统计（loss/avg/min/max/...），
      // 主题 PingChart 直接对 loss 调 toFixed(2)，缺字段会让整个组件渲染抛错。
      tasks: buildPingTasks(getPublicPingTasks({ entity_id: entityId }).tasks, records),
      basic_info: [],
      from: fromIso,
      to: nowIso
    };
  }

  if (!entityId) return metricKeys ? { count: 0, recordsByClient: {}, from: fromIso, to: nowIso } : [];
  const rows = await getMetricsRange(entityId, { hours, maxPoints });

  // Komari 契约：getRecords(type=load) 返回 []flatRecord（**裸数组**，字段扁平命名为
  // cpu / ram / ram_total / load / temp / disk / net_in ...）。社区主题 LoadChart 直接把它
  // 当数组渲染，此前返回 { count, records, ... } 信封会被判定为「暂无负载数据」。
  // 带 metric_keys 的调用（点分命名，diting 自有的兼容用法）保持原信封不变。
  if (!metricKeys || !metricKeys.length) {
    const fields = LOAD_TYPE_GROUPS[params.load_type] || LOAD_TYPE_GROUPS.all;
    return rows.map((m) => {
      const rec = { client: entityId, time: new Date(m.ts).toISOString() };
      for (const f of fields) {
        const col = LOAD_FIELD_MAP[f];
        if (col) rec[f] = Number(m[col]) || 0;
      }
      return rec;
    });
  }

  // 指定了 metric_keys：只返回这些字段（点分命名）
  const mapped = rows.map(m => {
    const rec = { time: new Date(m.ts).toISOString() };
    for (const k of metricKeys) {
      const col = RECORD_FIELD_MAP[k];
      if (col != null) rec[k] = Number(m[col]) || 0;
    }
    return rec;
  });

  return {
    count: mapped.length,
    records: mapped,
    recordsByClient: { [entityId]: mapped },
    from: fromIso,
    to: nowIso
  };
}

function getPublicPingTasks(params = {}) {
  // Komari 社区主题 PingChart 调用，返回某个 entity 的全部探针任务列表。
  const entityId = params.entity_id || params.uuid;
  const since = Date.now() - 24 * 3600 * 1000; // 最近 24h 内出现的 task
  // 只取探针三列并降采样（每 agent 最多 2000 点），规避 SELECT * 全表 OOM；task 名收集不依赖全量。
  const rows = (db.metricsProbesAll(since, 2000) || [])
    .filter(r => r.probes != null && (!entityId || r.agent_id === entityId));
  const taskMap = new Map();
  rows.forEach(r => {
    try {
      const probes = JSON.parse(r.probes || '{}');
      Object.keys(probes).forEach(name => {
        if (!taskMap.has(name)) {
          // id/task_id 用数字（Komari 的 PingTaskInfo.id 是数字），中文名放 name/task_name：
          // 主题用 id 做选中态与 series 关联，给中文名会导致「有 tab 没图」。
          const tid = probeTaskId(name);
          taskMap.set(name, {
            entity_id: r.agent_id,
            client: r.agent_id,
            id: tid,
            task_id: tid,
            task_name: name,
            name: name,
            type: 'icmp',
            interval_seconds: PROBE_TASK_INTERVAL,
            interval: PROBE_TASK_INTERVAL
          });
        }
      });
    } catch (_) {}
  });
  return { count: taskMap.size, tasks: Array.from(taskMap.values()) };
}

// Komari 官方 getRecords(type=ping).tasks 每项带窗口统计字段
// （web/rpc/jsonrpc/common.record.go:362-383）；其中 loss 会被 PingChart 直接用于
// toFixed(2)，缺字段会让整个延迟图组件渲染抛错。diting 此前直接复用 getPublicPingTasks()
// 的任务清单（纯元数据、无 loss），故在窗口记录上补齐官方统计。
function buildPingTasks(baseTasks, records) {
  return (baseTasks || []).map(t => {
    const pts = records.filter(r => r.task_id === t.task_id);
    const total = pts.length;
    const vals = pts
      .map(r => r.value)
      .filter(v => typeof v === 'number' && v >= 0)
      .sort((a, b) => a - b);
    const sum = vals.reduce((s, v) => s + v, 0);
    const avg = vals.length ? sum / vals.length : 0;
    const min = vals.length ? vals[0] : 0;
    const max = vals.length ? vals[vals.length - 1] : 0;
    const p50 = vals.length ? vals[Math.floor(vals.length * 0.5)] : 0;
    const p99 = vals.length ? vals[Math.floor(vals.length * 0.99)] : 0;
    const jitterBase = Math.max(Math.min(p50, 50), 10);
    let latest = -1;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (typeof pts[i].value === 'number' && pts[i].value >= 0) { latest = pts[i].value; break; }
    }
    return Object.assign({}, t, {
      default_on: true,
      loss: total ? (total - vals.length) / total * 100 : 0,
      min, max, avg, latest, total, p50, p99,
      p99_p50_ratio: p50 > 0 && p99 >= p50 ? (p99 - p50) / jitterBase : 0
    });
  });
}

// Komari 官方 flatRecord（web/rpc/jsonrpc/common.go:514-534）：扁平命名字段。
// GPU 不采集故刻意不输出，主题会把缺失值当 null，避免伪造 0 值。
function toFlatRecent(agentId, m) {
  const rec = { client: agentId, time: new Date(m.ts).toISOString() };
  for (const [field, col] of Object.entries(LOAD_FIELD_MAP)) {
    if (col) rec[field] = Number(m[col]) || 0;
  }
  rec.connections = Number(m.connections) || 0;
  rec.connections_udp = Number(m.connections_udp) || 0;
  return rec;
}

function getPingMetricStats(params = {}) {
  // Komari 社区主题 PingChart 调用 public:getPingMetricStats，期望返回 stats 数组。
  // 结构与 metrics:ping 里的 stats 一致：按 (client,task_id) 聚合延迟统计。
  const entityId = params.entity_id || params.uuid;
  const hours = clamp(Math.floor(Number(params.hours || params.h || 1) || 0), 0, 720);
  const maxCount = clamp(Math.floor(Number(params.max_points || params.maxPoints || 5000) || 0), 0, 5000) || 5000;
  // 与 getRecords(type=ping) 同源：按实体走单节点采样，避免跨节点切片把本实体挤空。
  return getProbeRecords({ hours, maxCount, entityId }).then((records) => {
  const agg = {};
  records.forEach(r => {
    if (entityId && r.client !== entityId) return;
    const k = r.client + '\x00' + r.task_id;
    if (!agg[k]) agg[k] = { entity_id: r.client, client: r.client, task_id: r.task_id, name: r.task_name || String(r.task_id), values: [] };
    if (typeof r.value === 'number' && r.value >= 0) agg[k].values.push(r.value);
  });
  const stats = Object.values(agg).map(a => {
    const vals = a.values.slice().sort((x, y) => x - y);
    const sum = vals.reduce((s, v) => s + v, 0);
    const avg = vals.length ? sum / vals.length : 0;
    const min = vals.length ? vals[0] : 0;
    const max = vals.length ? vals[vals.length - 1] : 0;
    const p50 = vals.length ? vals[Math.floor(vals.length * 0.5)] : 0;
    const p99 = vals.length ? vals[Math.floor(vals.length * 0.99)] : 0;
    const stddev = vals.length ? Math.sqrt(vals.reduce((s, v) => s + (v - avg) ** 2, 0) / vals.length) : 0;
    return {
      entity_id: a.entity_id,
      client: a.client,
      task_id: a.task_id,
      name: a.name,
      total: a.values.length,
      valid: vals.length,
      loss: 0,
      loss_approximate: false,
      interval: PROBE_TASK_INTERVAL,
      interval_seconds: PROBE_TASK_INTERVAL,
      type: 'icmp',
      avg, min, max, p50, p99,
      p99_p50_ratio: p50 ? p99 / p50 : 0,
      stddev,
      latest: vals.length ? vals[vals.length - 1] : 0
    };
  });
  return { count: stats.length, stats, tasks: buildPingTasks(getPublicPingTasks({ entity_id: entityId }).tasks, records), basic_info: [] };
  });
}

// ===== 方法表注册 =====
registerMethod('rpc.ping', () => 'pong');
registerMethod('rpc.getVersion', () => ({ hash: '-', version: 'diting-compat' }));
registerMethod('rpc.getMethods', () => Array.from(METHODS.keys()));

registerMethod('common:getNodes', () => Object.fromEntries(db.getMonitoredAgents().map(a => [a.id, toNode(a)])));
registerMethod('common:getNodesLatestStatus', getNodesLatestStatus);
// Komari 官方返回 { count, records: []flatRecord }（web/rpc/jsonrpc/common.go:536-542），
// 默认主题 LoadChart 的实时页签读 e.records 并按扁平字段取值；此前返回嵌套结构的裸数组 → 空图。
registerMethod('common:getNodeRecentStatus', (params = {}) => {
  const a = db.getAgent(params.uuid);
  if (!a) return { count: 0, records: [] };
  const m = db.getLatestMetric(a.id);
  if (!m) return { count: 0, records: [] };
  return { count: 1, records: [toFlatRecent(a.id, m)] };
});
registerMethod('common:getRecords', getRecords);

registerMethod('public:getMe', () => ({ logged_in: false, username: '', sso_id: '', sso_type: '', uuid: '' }));
registerMethod('public:getVersion', () => ({ hash: '-', version: 'diting-compat' }));
registerMethod('public:getPublicSettings', getPublicInfo);
registerMethod('public:getNodesInformation', () => Object.fromEntries(db.getMonitoredAgents().map(a => [a.id, toNode(a)])));
registerMethod('public:getClientRecentRecords', (params = {}) => {
  const a = db.getAgent(params.uuid);
  if (!a) return [];
  const rt = toRealtime(db.getLatestMetric(a.id));
  return rt ? [rt] : [];
});
registerMethod('public:getRecordsByUUID', (params = {}) => getRecords(params));
registerMethod('public:getPublicPingTasks', getPublicPingTasks);
registerMethod('public:listMetricDefinitions', () => METRIC_DEFINITIONS);
// 返回结构：保持 { start, end, series } 信封。实测 Glassmorphism v3.4.4 的 LoadChart 直接读
// `o.series`（`We(o.series)`），若按 Komari Go 侧的 []publicMetricSeries 裸数组返回，`o.series`
// 为 undefined → 全部图表判定「暂无数据」。（曾按官方 Go 结构改成裸数组，实测反而六张负载图全空，
// 已回退——以真实主题行为为准。）
registerMethod('public:queryMetrics', queryMetrics);
registerMethod('public:getPingMetricStats', getPingMetricStats);

// Komari 官方社区主题（Glassmorphism）底层 MetricsService 调用的原生方法名
// metrics:query 使用【位置参数数组】而非对象：
//   [metric_keys, entity_id, entity_ids, hours, start_time, end_time, max_points, aggregation, fill_empty, ...]
// metrics:definitions / metrics:ping 为普通对象参数。
registerMethod('metrics:definitions', () => METRIC_DEFINITIONS);
registerMethod('metrics:query', (params) => {
  // 兼容数组与对象两种参数形态
  let p = params;
  if (Array.isArray(params)) {
    const [metric_keys, entity_id, entity_ids, hours, start_time, end_time, max_points, aggregation, fill_empty] = params;
    p = { metric_keys, entity_id, entity_ids, hours, start_time, end_time, max_points, aggregation, fill_empty };
  }
  return queryMetrics(p);
});
registerMethod('metrics:ping', (params = {}) => {
  const p = Array.isArray(params) ? (params[0] || {}) : params;
  return getRecords({ ...p, type: 'ping' });
});

// 别名注册：第三方社区主题（如 Komari 官方 Glassmorphism）常以「无命名空间」形式
// 调用方法（getNodes / getNodesLatestStatus / ping / getVersion 等），而非 common:* / rpc.* 前缀。
// 为兼容不同主题实现，此处为每个已注册方法补一个「去掉前缀」的别名（同时处理冒号与点分隔）。
(function registerAliases() {
  for (const full of Array.from(METHODS.keys())) {
    const idx = full.search(/[:.]/);
    if (idx > 0) {
      const short = full.slice(idx + 1);
      if (short && !METHODS.has(short)) METHODS.set(short, METHODS.get(full));
    }
  }
})();

// 审查 C4：handler 可能异步（内部重聚合走 worker 线程），故 handleRpc 返回
// Promise——调用方（rpcMiddleware / WS 消息处理）必须 await。
async function handleRpc(method, params) {
  if (method.startsWith('admin:')) throw { code: -32000, message: 'admin not supported' };
  if (!METHODS.has(method)) throw { code: -32601, message: 'method not found' };
  return await METHODS.get(method)(params);
}

function rpcMiddleware(req, res) {
  if (!publicOpen()) {
    return res.status(403).json({ status: 'error', message: 'public page disabled' });
  }
  // Express 已通过 express.json() 中间件解析 body 到 req.body。
  // 切勿再用 req.on('data')/'end' 读 stream——stream 已被 Express 消费，
  // 'end' 事件不会再触发，会导致请求永久挂起。
  const msg = req.body || {};
  if (!msg || typeof msg !== 'object' || !msg.method) {
    return res.status(200).json({ jsonrpc: '2.0', error: { code: -32600, message: 'invalid request' }, id: msg?.id ?? null });
  }
  // 审查 C4：handleRpc 异步化（重聚合走 worker），错误仍以 JSON-RPC error 返回
  handleRpc(msg.method, msg.params).then((result) => {
    res.json({ jsonrpc: '2.0', result, id: msg.id });
  }).catch((err) => {
    res.status(200).json({
      jsonrpc: '2.0',
      error: { code: err.code || -32603, message: err.message || 'internal error' },
      id: msg?.id ?? null
    });
  });
}

module.exports = { handleRpc, registerMethod, rpcMiddleware, METHODS };
