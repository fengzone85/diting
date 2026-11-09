'use strict';
// 第三方主题 JSON-RPC 2.0 网关：为社区主题（如 Glassmorphism）提供查询接口。
// 方法表采用 Map 注册制，预留 plugin:<id>:* 命名空间供未来插件扩展。
const db = require('./db');
const { toNode, toRealtime, publicOpen, publicSettings, getNodesLatestStatus } = require('./compat');
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
  // 与 GET /api/public 共用单一真源（C5）：theme_settings 不再是恒空的写死字段。
  return publicSettings();
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
async function getRecords(params = {}, defaultHours = 1) {
  // 兼容前端 LoadChart 实际传参：entity_id + metric_keys + hours + max_points
  // 也兼容旧调用：uuid + type + hours + maxPoints。
  // defaultHours 由注册包装层按官方方法分流：common:getRecords=1、public:getRecordsByUUID=4，
  // metrics:* 为 diting 自造方法无官方基准、保持 1（方案 §7 Phase 3 分流表）。
  const entityId = params.entity_id || params.uuid || (Array.isArray(params.entity_ids) ? params.entity_ids[0] : undefined);
  const hours = clamp(Math.floor(Number(params.hours || params.h || defaultHours) || 0), 0, 720);
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
        // 官方 publicPingMetricTaskStats.TaskID 是 string（public.metric.go:100）；
        // 主题 re(o.task_id) 无条件调 .trim()，数字会让主路径抛错后回退 legacy（R11）。
        task_id: String(a.task_id),
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
      tasks: buildPingTasks(getPublicPingTasks({ entity_id: entityId }), records),
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
  // D2（已拍板 A）：回归官方裸数组（public.go:208-234），与 GET /api/task/ping 同形。
  // R1 已证伪「主题依赖 {count,tasks} 信封」：主题 go() 把 result 原样交给 it()/Us(t.map)，
  // 信封会抛 t.map is not a function 并静默回退 legacy；信封才是主路径断开的元凶。
  // 官方 7 字段之外保留 diting 兼容超集（A3 登记），不影响官方对齐验收。
  const entityId = params.entity_id || params.uuid;
  return officialPingTasks(entityId).map(t => Object.assign({}, t, {
    entity_id: entityId || (t.clients[0] || ''),
    client: entityId || (t.clients[0] || ''),
    task_id: t.id,
    task_name: t.name,
    interval_seconds: t.interval
  }));
}

/**
 * 官方 GET /api/task/ping（router.go:62 → public:getPublicPingTasks）的 7 字段裸数组：
 * id/weight/name/clients/default_on/type/interval（public.go:213-221，不暴露 target）。
 * 官方方法无参、返回全局任务表；clients 按 probes 重新聚合。
 * entityId 是 diting 超集（官方方法无参），仅用于单节点详情页过滤，登记为 A3 偏差。
 */
function officialPingTasks(entityId) {
  const since = Date.now() - 24 * 3600 * 1000;
  const rows = (db.metricsProbesAll(since, 2000) || [])
    .filter(r => r.probes != null && (!entityId || r.agent_id === entityId));
  const byName = new Map();
  rows.forEach(r => {
    try {
      const probes = JSON.parse(r.probes || '{}');
      Object.keys(probes).forEach(name => {
        if (!byName.has(name)) {
          byName.set(name, { id: probeTaskId(name), name, clients: new Set() });
        }
        byName.get(name).clients.add(r.agent_id);
      });
    } catch (_) { /* 坏 probes JSON 跳过 */ }
  });
  return Array.from(byName.values()).map(t => ({
    id: t.id,
    weight: 0,
    name: t.name,
    clients: Array.from(t.clients),
    // diting 无「任务默认开启」开关语义，按约定恒 true 并登记为偏差（A3）。
    default_on: true,
    type: 'icmp',
    interval: PROBE_TASK_INTERVAL
  }));
}

/**
 * 官方 public:getPingRecords（web/rpc/jsonrpc/public.go:300-320）记录端点。
 * 参数 uuid / task_id 至少一个，hours 默认 4；返回 { count, basic_info, records }，
 * records 项为 { task_id, time, value, client? }。与 /api/records/ping 是两条不同绑定。
 */
async function getPublicPingRecords(params = {}) {
  const entityId = params.uuid || params.entity_id;
  const taskId = params.task_id != null && params.task_id !== '' ? Number(params.task_id) : null;
  const hours = clamp(Math.floor(Number(params.hours || 4) || 0), 0, 720);
  const maxCount = clamp(Math.floor(Number(params.max_count || params.maxCount || 4000) || 0), 0, 5000) || 4000;
  let records = await getProbeRecords({ hours, maxCount, entityId });
  if (Number.isFinite(taskId)) records = records.filter(r => r.task_id === taskId);
  const out = records.map(r => ({
    task_id: r.task_id,
    time: r.time,
    value: r.value,
    client: r.client
  }));
  // 官方 basic_info 按 client 聚合窗口内的丢包率与最小/最大延迟。
  const byClient = new Map();
  out.forEach(r => {
    if (!byClient.has(r.client)) byClient.set(r.client, { client: r.client, total: 0, loss: 0, min: 0, max: 0 });
    const s = byClient.get(r.client);
    s.total++;
    if (r.value < 0) s.loss++;
    else {
      if (s.min === 0 || r.value < s.min) s.min = r.value;
      if (r.value > s.max) s.max = r.value;
    }
  });
  const basic_info = Array.from(byClient.values()).map(s => ({
    client: s.client,
    loss: s.total ? s.loss / s.total * 100 : 0,
    min: s.min,
    max: s.max
  }));
  return { count: out.length, basic_info, records: out };
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
  // 官方 publicPingMetricStatsParams（public.metric.go:81-96）支持 start/end/start_time/end_time；
  // 响应为 { start, end, interval_seconds, stats, count }（:119-125）。
  const entityId = params.entity_id || params.uuid || (Array.isArray(params.entity_ids) ? params.entity_ids[0] : undefined);
  const startMs = Date.parse(params.start || params.start_time || '') || null;
  const endMs = Date.parse(params.end || params.end_time || '') || null;
  const hours = startMs && endMs
    ? Math.max(0, (endMs - startMs) / 3600000)
    : clamp(Math.floor(Number(params.hours || params.h || 1) || 0), 0, 720);
  const maxCount = clamp(Math.floor(Number(params.max_points || params.maxPoints || 5000) || 0), 0, 5000) || 5000;
  const since = startMs || (endMs ? endMs - hours * 3600000 : Date.now() - hours * 3600000);
  const until = endMs || Date.now();
  // 与 getRecords(type=ping) 同源：按实体走单节点采样，避免跨节点切片把本实体挤空。
  // getProbeRecords 只按 hours 采样，绝对时间窗在结果上二次过滤（不改 worker 采样接口）。
  return getProbeRecords({ hours, maxCount, entityId }).then((rawRecords) => {
    const records = rawRecords.filter(r => {
      const t = Date.parse(r.time);
      return t >= since && t <= until;
    });
    const agg = {};
    records.forEach(r => {
      if (entityId && r.client !== entityId) return;
      const k = r.client + '\x00' + r.task_id;
      if (!agg[k]) agg[k] = { entity_id: r.client, client: r.client, task_id: r.task_id, name: r.task_name || String(r.task_id), values: [], total: 0 };
      // 失败样本在 getProbeRecords 里编码为 value=-1；必须计入分母，否则全丢包任务
      // 会因 valid=0 被主题当成「无样本」丢掉，卡片丢包率永远显示 0。
      agg[k].total += 1;
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
        // 官方 publicPingMetricTaskStats.TaskID 是 string（public.metric.go:100）；
        // 主题 re(o.task_id) 无条件调 .trim()，数字会让主路径抛错后回退 legacy（R11）。
        task_id: String(a.task_id),
        name: a.name,
        total: a.total,
        valid: vals.length,
        loss: a.total > 0 ? Math.max(0, ((a.total - vals.length) / a.total) * 100) : 0,
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
    // 顶层 interval_seconds 是窗口降采样间隔（public.metric.go:483 interval.Seconds()），
    // 不是探测周期；照抄 PROBE_TASK_INTERVAL(60) 是错值。
    const intervalSeconds = maxCount > 0 ? (until - since) / 1000 / maxCount : 0;
    return {
      start: new Date(since).toISOString(),
      end: new Date(until).toISOString(),
      interval_seconds: intervalSeconds,
      count: stats.length,
      stats,
      tasks: buildPingTasks(getPublicPingTasks({ entity_id: entityId }), records),
      basic_info: []
    };
  });
}

// 官方 common:getNodes{uuid}、getNodesLatestStatus{uuid,uuids[]} 的节点过滤
// （web/rpc/jsonrpc/common.go:217-221,287-291）。diting 仍返回 uuid→node 的 map，
// 只在 map 上做过滤（形状差异登记，不改既有主题依赖）。
function nodeFilter(params = {}) {
  const ids = [];
  if (typeof params.uuid === 'string' && params.uuid) ids.push(params.uuid);
  if (Array.isArray(params.uuids)) {
    for (const x of params.uuids) if (typeof x === 'string' && x) ids.push(x);
  }
  return ids.length ? new Set(ids) : null;
}

// ===== 方法表注册 =====
registerMethod('rpc.ping', () => 'pong');
// diting 自造原名，主题服务层直接调用，必须保留；官方名另行补在下方。
registerMethod('rpc.getVersion', () => ({ hash: '-', version: 'diting-compat' }));
registerMethod('rpc.getMethods', () => Array.from(METHODS.keys()));

// 官方内建方法（komari/pkg/rpc/internal.go:26-90）。rpc.version 返回协议版本字符串。
const RPC_VERSION = '2.0'; // komari/pkg/rpc/rpc.go:4
registerMethod('rpc.version', () => RPC_VERSION);
registerMethod('rpc.methods', (params = {}) => {
  const internal = !!(params && params.internal);
  return Array.from(METHODS.keys())
    .filter(m => internal || !m.startsWith('rpc.'))
    .sort();
});
// diting 无 MethodMeta 注册表，这里按官方 []MethodMeta 形状返回可实现的降级元数据
// （name/summary/returns），不编造参数说明；指定 method 时返回单项。
function rpcMethodMeta(name) {
  return {
    name,
    summary: name.startsWith('rpc.') ? 'Internal RPC method' : 'Komari compatible method',
    returns: 'any'
  };
}
registerMethod('rpc.help', (params = {}) => {
  const name = params && params.method;
  if (name) return METHODS.has(name) ? rpcMethodMeta(name) : null;
  return Array.from(METHODS.keys()).filter(m => !m.startsWith('rpc.')).sort().map(rpcMethodMeta);
});
registerMethod('rpc.getHelp', (params = {}) => METHODS.get('rpc.help')(params));

registerMethod('common:getNodes', (params = {}) => {
  const wanted = nodeFilter(params);
  const agents = db.getMonitoredAgents().filter(a => !wanted || wanted.has(a.id));
  return Object.fromEntries(agents.map(a => [a.id, toNode(a)]));
});
registerMethod('common:getNodesLatestStatus', (params = {}) => {
  const wanted = nodeFilter(params);
  const all = getNodesLatestStatus();
  if (!wanted || !all || typeof all !== 'object') return all;
  return Object.fromEntries(Object.entries(all).filter(([id]) => wanted.has(id)));
});
// Komari 官方返回 { count, records: []flatRecord }（web/rpc/jsonrpc/common.go:536-542），
// 默认主题 LoadChart 的实时页签读 e.records 并按扁平字段取值；此前返回嵌套结构的裸数组 → 空图。
registerMethod('common:getNodeRecentStatus', (params = {}) => {
  const a = db.getAgent(params.uuid);
  if (!a) return { count: 0, records: [] };
  const m = db.getLatestMetric(a.id);
  if (!m) return { count: 0, records: [] };
  return { count: 1, records: [toFlatRecent(a.id, m)] };
});
// 官方 common:getRecords 默认 hours=1（common.record.go:56-59）。
registerMethod('common:getRecords', (params = {}) => getRecords(params, 1));
// 官方 Common RPC（komari/web/rpc/jsonrpc/README.md）：与 public:* 共用同一真源。
registerMethod('common:getMe', () => ({ logged_in: false, username: 'Guest', sso_id: '', sso_type: '', uuid: '' }));
registerMethod('common:getPublicInfo', getPublicInfo);
registerMethod('common:getVersion', () => ({ hash: '-', version: 'diting-compat' }));
// 主题服务层实际会调用的自造名，补齐避免静默 -32601。
registerMethod('common:getBackendVersion', () => ({ hash: '-', version: 'diting-compat' }));

registerMethod('public:getMe', () => ({ logged_in: false, username: 'Guest', sso_id: '', sso_type: '', uuid: '' }));
registerMethod('public:getVersion', () => ({ hash: '-', version: 'diting-compat' }));
registerMethod('public:getPublicSettings', getPublicInfo);
registerMethod('public:getNodesInformation', () => Object.fromEntries(db.getMonitoredAgents().map(a => [a.id, toNode(a)])));
registerMethod('public:getClientRecentRecords', (params = {}) => {
  const a = db.getAgent(params.uuid);
  if (!a) return [];
  const rt = toRealtime(db.getLatestMetric(a.id));
  return rt ? [rt] : [];
});
// 官方 public:getRecordsByUUID 默认 hours=4（public.go:148-151），与 common:getRecords 不同。
registerMethod('public:getRecordsByUUID', (params = {}) => getRecords(params, 4));
registerMethod('public:getPublicPingTasks', getPublicPingTasks);
// 官方记录端点（router.go:61），与 /api/records/ping 是两条不同绑定。
registerMethod('public:getPingRecords', getPublicPingRecords);
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
  // metrics:* 是 diting 自造方法，官方源码无此命名空间、无 hours 基准，保持 1（Phase 3 登记）。
  return getRecords({ ...p, type: 'ping' }, 1);
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

// 官方请求体校验（komari/pkg/rpc/request.go:34-45）：版本必须为 2.0、method 非空。
function validateRpcMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'invalid request';
  if (msg.jsonrpc !== '2.0') return 'invalid jsonrpc version';
  if (typeof msg.method !== 'string' || !msg.method.trim()) return 'method required';
  return null;
}

// 官方 response.go 的 `omitempty`：id / result 为 nil 时省略字段，不输出 null。
function rpcResponse(id, payload) {
  const body = { jsonrpc: '2.0' };
  if (id !== undefined && id !== null) body.id = id;
  return Object.assign(body, payload);
}
function rpcSuccess(id, result) {
  return result === undefined || result === null
    ? rpcResponse(id, {})
    : rpcResponse(id, { result });
}
function rpcError(id, code, message) {
  return rpcResponse(id, { error: { code, message } });
}

// 批量上限：官方无此限制，diting 为防未认证请求放大 heavyQuery worker 附加（方案 R9）。
const MAX_RPC_BATCH = 50;

function rpcMiddleware(req, res) {
  if (!publicOpen()) {
    return res.status(403).json({ status: 'error', message: 'public page disabled' });
  }
  // Express 已通过 express.json() 中间件解析 body 到 req.body。
  // 切勿再用 req.on('data')/'end' 读 stream——stream 已被 Express 消费，
  // 'end' 事件不会再触发，会导致请求永久挂起。
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  // 请求体校验阶段：任一条校验失败 → 整批拒（官方 parse.go:22-56），
  // 且官方返回 HTTP 400（transport.go:129），不是 diting 此前的 200。
  if (messages.length === 0) return res.status(400).json(rpcError(null, -32600, 'empty batch'));
  if (messages.length > MAX_RPC_BATCH) return res.status(400).json(rpcError(null, -32600, 'batch too large'));
  for (const msg of messages) {
    const err = validateRpcMessage(msg);
    if (err) return res.status(400).json(rpcError(null, -32600, err));
  }
  // 方法执行阶段：逐条独立 dispatch，错误只落在自身的 error 对象上（transport.go:133-141）。
  // notification（无 id）也回包：response.go 注释说不回，但 servePost 无条件 append，
  // 以实现为准（方案 A4 登记「注释与实现不一致」）。
  const dispatchOne = (msg) => handleRpc(msg.method, msg.params).then(
    (result) => rpcSuccess(msg.id, result),
    (err) => rpcError(msg.id, err?.code || -32603, err?.message || 'internal error')
  );
  Promise.all(messages.map(dispatchOne)).then((responses) => {
    // 官方按 responses 长度决定形状：1 条返单对象，多条返数组。
    res.status(200).json(responses.length === 1 ? responses[0] : responses);
  });
}

module.exports = { handleRpc, registerMethod, rpcMiddleware, METHODS, officialPingTasks };
