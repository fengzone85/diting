'use strict';
// 第三方主题 JSON-RPC 2.0 网关：为社区主题（如 Glassmorphism）提供查询接口。
// 方法表采用 Map 注册制，预留 plugin:<id>:* 命名空间供未来插件扩展。
const db = require('./db');
const { toNode, toRealtime, publicOpen, getNodesLatestStatus } = require('./compat');
const { METRIC_DEFINITIONS, queryMetrics } = require('./compat-metrics');

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
  let rows = db.getMetrics(agentId, since);
  if (rows.length > maxPoints) {
    const step = Math.ceil(rows.length / maxPoints);
    rows = rows.filter((_, i) => i % step === 0);
  }
  return rows;
}

function getProbeRecords({ hours = 1, maxCount = 100 } = {}) {
  hours = clamp(Math.floor(Number(hours) || 0), 0, 720);
  maxCount = clamp(Math.floor(Number(maxCount) || 0), 0, 5000);
  const since = Date.now() - hours * 3600 * 1000;
  const rows = (db.getMetricsAll(since) || [])
    .filter(r => r.probes != null)
    .slice(0, maxCount * 10);

  const records = [];
  rows.forEach(r => {
    try {
      const probes = JSON.parse(r.probes || '{}');
      Object.entries(probes).forEach(([name, val]) => {
        records.push({
          client: r.agent_id,
          task_id: name,
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
  'swap.used': 'mem_used',
  'swap.total': 'mem_total',
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

function getRecords(params = {}) {
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
    const records = getProbeRecords({ hours, maxCount: maxPoints });
    const byClient = {};
    records.forEach(r => {
      (byClient[r.client] = byClient[r.client] || []).push(r);
    });
    return {
      count: records.length,
      records,
      recordsByClient: byClient,
      basic_info: [],
      tasks: [],
      from: fromIso,
      to: nowIso
    };
  }

  if (!entityId) return { count: 0, recordsByClient: {}, from: fromIso, to: nowIso };
  const rows = getMetricsRange(entityId, { hours, maxPoints });

  // 若指定了 metric_keys，只返回这些字段（点分命名）；否则返回全部已映射字段
  const wantKeys = metricKeys && metricKeys.length ? metricKeys : Object.keys(RECORD_FIELD_MAP);
  const mapped = rows.map(m => {
    const rec = { time: new Date(m.ts).toISOString() };
    for (const k of wantKeys) {
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

function getPublicPingTasks() {
  return db.getAgents().map(a => ({
    client: a.id,
    targets: (a.probe_targets || '').split(',').filter(Boolean)
  }));
}

function getPingMetricStats() {
  return { count: 0, tasks: [], basic_info: [] };
}

// ===== 方法表注册 =====
registerMethod('rpc.ping', () => 'pong');
registerMethod('rpc.getVersion', () => ({ hash: '-', version: 'diting-compat' }));
registerMethod('rpc.getMethods', () => Array.from(METHODS.keys()));

registerMethod('common:getNodes', () => Object.fromEntries(db.getAgents().map(a => [a.id, toNode(a)])));
registerMethod('common:getNodesLatestStatus', getNodesLatestStatus);
registerMethod('common:getNodeRecentStatus', (params = {}) => {
  const a = db.getAgent(params.uuid);
  if (!a) return [];
  const rt = toRealtime(db.getLatestMetric(a.id));
  return rt ? [rt] : [];
});
registerMethod('common:getRecords', getRecords);

registerMethod('public:getMe', () => ({ logged_in: false, username: '', sso_id: '', sso_type: '', uuid: '' }));
registerMethod('public:getVersion', () => ({ hash: '-', version: 'diting-compat' }));
registerMethod('public:getPublicSettings', getPublicInfo);
registerMethod('public:getNodesInformation', () => Object.fromEntries(db.getAgents().map(a => [a.id, toNode(a)])));
registerMethod('public:getClientRecentRecords', (params = {}) => {
  const a = db.getAgent(params.uuid);
  if (!a) return [];
  const rt = toRealtime(db.getLatestMetric(a.id));
  return rt ? [rt] : [];
});
registerMethod('public:getRecordsByUUID', (params = {}) => getRecords(params));
registerMethod('public:getPublicPingTasks', getPublicPingTasks);
registerMethod('public:listMetricDefinitions', () => METRIC_DEFINITIONS);
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
registerMethod('metrics:ping-stats', () => getPingMetricStats());

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

function handleRpc(method, params) {
  if (method.startsWith('admin:')) throw { code: -32000, message: 'admin not supported' };
  if (!METHODS.has(method)) throw { code: -32601, message: 'method not found' };
  return METHODS.get(method)(params);
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
  try {
    const result = handleRpc(msg.method, msg.params);
    res.json({ jsonrpc: '2.0', result, id: msg.id });
  } catch (err) {
    res.status(200).json({
      jsonrpc: '2.0',
      error: { code: err.code || -32603, message: err.message || 'internal error' },
      id: msg?.id ?? null
    });
  }
}

module.exports = { handleRpc, registerMethod, rpcMiddleware, METHODS };
