'use strict';
// 标准公开只读 API 层（/api/v1/*）—— 方案 C 的「标准 API」层
// 与任何皮肤/主题协议解耦：diting 只暴露语义清晰的 RESTful 资源，
// Komari/Glassmorphism 等协议的翻译由独立 adapter 仓库负责。
// 仅暴露只读、脱敏数据，且受 ui_settings.public_enabled 门控（与 /api/public/* 一致）。
const express = require('express');
const db = require('./db');
const router = express.Router();

const offlineMs = () => Number(process.env.OFFLINE_THRESHOLD_SEC || 60) * 1000;
const isOnline = (a) => (Date.now() - (a.last_seen || 0)) <= offlineMs();

// 统一响应信封：{ code, message, data }
function ok(res, data) { res.json({ code: 0, message: '', data }); }
function disabled(res) {
  res.status(403).json({ code: 1, message: 'public page disabled', data: null });
}

// 能力声明：adapter/模板据此隐藏 diting 不采集的字段
const CAPABILITY = {
  gpu: false,
  connections: false,
  process: false,
  virtualization: false,
  arch: false,
  cpu_cores: false,
  cpu_name: false,
  temperature: true,
  disks: true,
  probes: true
};

// 节点基础信息（标准字段语义，缺失统一 null / 空对象，不猜默认值）
function toNode(a) {
  const m = db.getLatestMetric(a.id) || {};
  return {
    uuid: a.id,
    name: a.name,
    os: a.os || null,
    kernel: a.hostname || null,          // 如实填 hostname（diting 无独立内核版本）
    gpu: { model: null, count: null, detailed_info: [] },
    ram: { total: Number(m.mem_total) || null, used: Number(m.mem_used) || null },
    swap: { total: Number(m.swap_total) || null, used: Number(m.swap_used) || null },
    disk_total: Number(m.disk_total) || null,
    connections: { tcp: null, udp: null }, // diting 不采集连接数
    process: null,                          // diting 不采集进程数
    temperature: m.temp != null ? Number(m.temp) : null,
    online: isOnline(a),
    region: a.country || null,
    group: a.grp || null,
    remark: a.note || null,                 // 公开备注
    expired_at: a.expire_at || null,        // 到期时间
    traffic_limit: Number(a.monthly_quota_gb) > 0 ? Math.round(a.monthly_quota_gb * 1e9) : 0,
    traffic_limit_type: 'max',
    created_at: new Date(a.created_at).toISOString(),
    updated_at: new Date(a.last_seen || a.created_at).toISOString()
  };
}

// 实时快照（标准字段，与 toNode 同语义）
function toRealtime(m) {
  if (!m) return null;
  return {
    cpu: { usage: Number(m.cpu) || 0 },
    ram: { total: Number(m.mem_total) || null, used: Number(m.mem_used) || null },
    swap: { total: Number(m.swap_total) || null, used: Number(m.swap_used) || null },
    load: { load1: Number(m.load1) || 0, load5: Number(m.load5) || 0, load15: Number(m.load15) || 0 },
    disk: { total: Number(m.disk_total) || null, used: Number(m.disk_used) || null },
    network: {
      up: Number(m.net_tx_rate) || 0,
      down: Number(m.net_rx_rate) || 0,
      totalUp: Number(m.net_tx_month) || 0,
      totalDown: Number(m.net_rx_month) || 0
    },
    connections: { tcp: null, udp: null },
    process: null,
    temperature: m.temp != null ? Number(m.temp) : null,
    uptime: Number(m.uptime) || 0
  };
}

function publicOpen() {
  const ui = db.getUiSettings();
  return ui.public_enabled !== false;
}

// 通用门控中间件：所有 /api/v1 只读接口均要求公开页开启
router.use((req, res, next) => {
  if (!publicOpen()) return disabled(res);
  next();
});

// 应用层限流（兜底，Nginx 限流才是真实边界）：每 IP 每 10s 最多 30 次
const V1_RATE_WINDOW = 10000, V1_RATE_MAX = 30, V1_MAP_CAP = 10000;
const v1RateHits = new Map();
setInterval(() => v1RateHits.clear(), V1_RATE_WINDOW).unref?.();
router.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const rec = v1RateHits.get(ip);
  if (!rec || now > rec.reset) {
    if (v1RateHits.size >= V1_MAP_CAP) v1RateHits.clear();
    v1RateHits.set(ip, { reset: now + V1_RATE_WINDOW, count: 1 });
    return next();
  }
  rec.count++;
  if (rec.count > V1_RATE_MAX) return res.status(429).json({ code: 1, message: 'too many requests', data: null });
  next();
});

function clamp(v, min, max) { return Math.max(min, Math.min(v, max)); }

// GET /api/v1/sites —— 站点公开信息
router.get('/sites', (req, res) => {
  const ui = db.getUiSettings();
  ok(res, {
    name: ui.site_title || 'diting',
    description: '',
    public_enabled: true,
    locale: 'zh-CN'
  });
});

// GET /api/v1/nodes —— 节点列表（不含实时负载）
router.get('/nodes', (req, res) => {
  ok(res, db.getAgents().map(toNode));
});

// GET /api/v1/nodes/:uuid —— 单节点详情（基础信息 + 实时 + 能力声明）
router.get('/nodes/:uuid', (req, res) => {
  const a = db.getAgent(req.params.uuid);
  if (!a) return res.status(404).json({ code: 1, message: 'node not found', data: null });
  ok(res, { node: toNode(a), realtime: toRealtime(db.getLatestMetric(a.id)), capability: CAPABILITY });
});

// GET /api/v1/nodes/:uuid/metrics?hours=24&max_points=100 —— 时序指标（标准字段）
router.get('/nodes/:uuid/metrics', (req, res) => {
  const a = db.getAgent(req.params.uuid);
  if (!a) return res.status(404).json({ code: 1, message: 'node not found', data: null });
  const hours = clamp(Math.floor(Number(req.query.hours) || 0), 0, 720);
  const maxPoints = clamp(Math.floor(Number(req.query.max_points) || 0), 0, 5000);
  const since = Date.now() - hours * 3600 * 1000;
  let rows = db.getMetrics(a.id, since);
  if (rows.length > maxPoints) {
    const step = Math.ceil(rows.length / maxPoints);
    rows = rows.filter((_, i) => i % step === 0);
  }
  const points = rows.map(r => ({
    ts: new Date(r.ts).toISOString(),
    cpu: Number(r.cpu) || 0,
    mem_used: Number(r.mem_used) || 0,
    mem_total: Number(r.mem_total) || 0,
    load1: Number(r.load1) || 0,
    load5: Number(r.load5) || 0,
    load15: Number(r.load15) || 0,
    net_rx_rate: Number(r.net_rx_rate) || 0,
    net_tx_rate: Number(r.net_tx_rate) || 0,
    net_rx_month: Number(r.net_rx_month) || 0,
    net_tx_month: Number(r.net_tx_month) || 0,
    disk_used: Number(r.disk_used) || 0,
    disk_total: Number(r.disk_total) || 0,
    swap_pct: Number(r.swap_pct) || 0,
    temperature: r.temp != null ? Number(r.temp) : null
  }));
  ok(res, { uuid: a.id, points, downsampled: rows.length > maxPoints, hours });
});

// GET /api/v1/nodes/:uuid/records?hours=24&max_points=100 —— 历史探针记录（ping）
router.get('/nodes/:uuid/records', (req, res) => {
  const a = db.getAgent(req.params.uuid);
  if (!a) return res.status(404).json({ code: 1, message: 'node not found', data: null });
  const hours = clamp(Math.floor(Number(req.query.hours) || 0), 0, 720);
  const maxCount = clamp(Math.floor(Number(req.query.max_points) || 0), 0, 5000);
  const since = Date.now() - hours * 3600 * 1000;
  const rows = (db.getMetrics(a.id, since) || [])
    .filter(r => r.probes != null)
    .slice(0, maxCount * 10);
  const records = [];
  rows.forEach(r => {
    try {
      const probes = JSON.parse(r.probes || '{}');
      Object.entries(probes).forEach(([label, val]) => {
        if (val && typeof val.ms === 'number') {
          records.push({ task_id: label, time: new Date(r.ts).toISOString(), value: val.ms });
        }
      });
    } catch (_) {}
  });
  ok(res, { uuid: a.id, records: records.slice(0, maxCount) });
});

// GET /api/v1/nodes/:uuid/capability —— 能力声明（adapter/模板据此隐藏字段）
router.get('/nodes/:uuid/capability', (req, res) => {
  const a = db.getAgent(req.params.uuid);
  if (!a) return res.status(404).json({ code: 1, message: 'node not found', data: null });
  ok(res, Object.assign({}, CAPABILITY, { probes_targets: (a.probe_targets || '').split(',').filter(Boolean) }));
});

module.exports = { router, toNode, toRealtime, isOnline, publicOpen, CAPABILITY };
