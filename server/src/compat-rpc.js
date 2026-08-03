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
  const rows = db.prepare(
    'SELECT agent_id, ts, probes FROM metrics WHERE ts >= ? AND probes IS NOT NULL ORDER BY ts ASC LIMIT ?'
  ).all(since, maxCount * 10);

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

function getRecords(params = {}) {
  const { uuid, type = 'load', hours = 1, maxPoints = 100 } = params;
  const nowIso = new Date().toISOString();
  const fromIso = new Date(Date.now() - clamp(Math.floor(Number(hours) || 0), 0, 720) * 3600 * 1000).toISOString();

  if (type === 'ping') {
    const records = getProbeRecords({ hours, maxCount: maxPoints });
    return {
      count: records.length,
      records,
      basic_info: [],
      tasks: [],
      from: fromIso,
      to: nowIso
    };
  }

  if (!uuid) return { count: 0, records: {}, from: fromIso, to: nowIso };
  const rows = getMetricsRange(uuid, { hours, maxPoints });
  return {
    count: rows.length,
    records: { [uuid]: rows },
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
