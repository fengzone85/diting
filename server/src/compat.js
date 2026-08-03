'use strict';
// 第三方主题兼容 API 层（PoC）
// 让 diting 的公开数据以社区主题所期望的接口形状暴露，
// 从而使「适配路线」可行：把社区主题的前端请求层指向本服务即可复用。
// 仅暴露只读、脱敏数据，且同样受 ui_settings.public_enabled 开关约束（与 /api/public/* 一致）。
const express = require('express');
const router = express.Router();
const db = require('./db');

const offlineMs = () => Number(process.env.OFFLINE_THRESHOLD_SEC || 60) * 1000;
const isOnline = (a) => (Date.now() - (a.last_seen || 0)) <= offlineMs();

// 历史曲线时间窗（与 api.js RANGES 保持一致）
const RANGES_C = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };

// ISO 3166-1 alpha-2 -> 国旗 emoji（region 字段用国旗表情）
function flagEmoji(iso) {
  if (!iso || iso.length !== 2) return '';
  const cc = iso.toUpperCase();
  const A = 0x1F1E6;
  const base = 'A'.charCodeAt(0);
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(A + cc.charCodeAt(0) - base) + String.fromCodePoint(A + cc.charCodeAt(1) - base);
}

// diting agent -> 社区主题 node 列表项（/api/nodes）
function toNode(a) {
  const m = db.getLatestMetric(a.id) || {};
  return {
    uuid: a.id,
    name: a.name,
    cpu_name: '',
    virtualization: '',
    arch: '',
    cpu_cores: 0,
    cpu_physical_cores: 0,
    os: a.os || '',
    kernel_version: a.hostname || '',
    gpu_name: 'None',
    region: flagEmoji(a.country),
    mem_total: Number(m.mem_total) || 0,
    swap_total: Number(m.swap_total) || 0,
    disk_total: Number(m.disk_total) || 0,
    weight: 0,
    price: -1,
    billing_cycle: 30,
    auto_renewal: true,
    currency: '$',
    expired_at: a.expire_at ? a.expire_at : '0001-01-01T00:00:00.0000000+00:00',
    group: a.grp || '',
    tags: '',
    hidden: false,
    public_remark: a.note || '',
    traffic_limit: Number(a.monthly_quota_gb) > 0 ? Math.round(a.monthly_quota_gb * 1e9) : 0,
    traffic_limit_type: 'max',
    created_at: new Date(a.created_at).toISOString(),
    updated_at: new Date(a.last_seen || a.created_at).toISOString()
  };
}

// diting metric -> 社区主题实时嵌套结构（/api/recent/{uuid} 与 WS 同构）
function toRealtime(m) {
  if (!m) return null;
  return {
    cpu: { usage: Number(m.cpu) || 0 },
    ram: { total: Number(m.mem_total) || 0, used: Number(m.mem_used) || 0 },
    swap: { total: Number(m.swap_total) || 0, used: Number(m.swap_used) || 0 },
    load: { load1: Number(m.load1) || 0, load5: Number(m.load5) || 0, load15: Number(m.load15) || 0 },
    disk: { total: Number(m.disk_total) || 0, used: Number(m.disk_used) || 0 },
    network: {
      up: Number(m.net_tx_rate) || 0,
      down: Number(m.net_rx_rate) || 0,
      totalUp: Number(m.net_tx_month) || 0,
      totalDown: Number(m.net_rx_month) || 0
    },
    connections: { tcp: 0, udp: 0 },
    uptime: Number(m.uptime) || 0,
    process: 0,
    message: '',
    updated_at: new Date(m.ts).toISOString()
  };
}

function publicOpen() {
  const ui = db.getUiSettings();
  return !!(ui && ui.public_enabled);
}

// 实时状态映射（供 JSON-RPC /api/rpc2 的 common:getNodesLatestStatus 使用）
// 注意：这里返回的是 Komari 原版 recordLike 扁平格式（含 online 字段），
// 而非 toRealtime 的嵌套结构。主题 updateNodeStatuses 期望扁平字段：
// L(node, status) => { online, time, cpu, ram, ram_total, swap, ... }
function getNodesLatestStatus() {
  if (!publicOpen()) return {};
  const agents = db.getAgents();
  const data = {};
  for (const a of agents) {
    const m = db.getLatestMetric(a.id);
    if (!m) continue;
    data[a.id] = {
      client: a.id,
      time: new Date(m.ts).toISOString(),
      cpu: Number(m.cpu) || 0,
      gpu: 0,
      ram: Number(m.mem_used) || 0,
      ram_total: Number(m.mem_total) || 0,
      swap: Number(m.swap_used) || 0,
      swap_total: Number(m.swap_total) || 0,
      load: Number(m.load1) || 0,
      load5: Number(m.load5) || 0,
      load15: Number(m.load15) || 0,
      temp: 0,
      disk: Number(m.disk_used) || 0,
      disk_total: Number(m.disk_total) || 0,
      net_in: Number(m.net_rx_rate) || 0,
      net_out: Number(m.net_tx_rate) || 0,
      net_total_up: Number(m.net_tx_month) || 0,
      net_total_down: Number(m.net_rx_month) || 0,
      process: 0,
      connections: 0,
      connections_udp: 0,
      online: isOnline(a),
      uptime: Number(m.uptime) || 0
    };
  }
  return data;
}

// 全量快照（供 WebSocket /api/clients 使用，结构与社区主题一致）
function snapshot() {
  if (!publicOpen()) return { data: { online: [], data: {} }, status: 'success' };
  const agents = db.getAgents();
  const online = [];
  const data = {};
  for (const a of agents) {
    if (isOnline(a)) online.push(a.id);
    const rt = toRealtime(db.getLatestMetric(a.id));
    if (rt) data[a.id] = rt;
  }
  return { data: { online, data }, status: 'success' };
}

const guard = (req, res, next) => {
  if (!publicOpen()) return res.status(403).json({ status: 'error', message: 'public page disabled', data: null });
  next();
};

// 社区主题公开接口应用层限流（Nginx 兜底外的应用层保险）：每 IP 每 10s 最多 30 次。
const COMPAT_RATE_WINDOW = 10000, COMPAT_RATE_MAX = 30, COMPAT_MAP_CAP = 10000;
const compatRateHits = new Map();
setInterval(() => compatRateHits.clear(), COMPAT_RATE_WINDOW).unref?.();
router.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const rec = compatRateHits.get(ip);
  if (!rec || now > rec.reset) {
    if (compatRateHits.size >= COMPAT_MAP_CAP) compatRateHits.clear();
    compatRateHits.set(ip, { reset: now + COMPAT_RATE_WINDOW, count: 1 });
    return next();
  }
  rec.count++;
  if (rec.count > COMPAT_RATE_MAX) return res.status(429).json({ status: 'error', message: 'too many requests' });
  next();
});

// GET /api/public —— 站点公开属性（主题用）
router.get('/public', guard, (req, res) => {
  const ui = db.getUiSettings();
  res.json({
    status: 'success', message: '',
    data: {
      cors_origin_check_enabled: false,
      custom_body: '', custom_head: '',
      description: '',
      disable_password_login: true,
      oauth_enable: false, oauth_provider: '',
      ping_record_preserve_time: 48,
      private_site: false,
      record_enabled: false, record_preserve_time: 720,
      sitename: ui.site_title || 'diting',
      theme: ui.public_theme || 'Mochi',
      theme_settings: {}
    }
  });
});

// GET /api/version
router.get('/version', (req, res) => {
  res.json({ status: 'success', message: '', data: { hash: '-', version: 'diting-compat' } });
});

// GET /api/nodes —— 节点基础信息列表（不含实时负载）
router.get('/nodes', guard, (req, res) => {
  const agents = db.getAgents();
  res.json({ status: 'success', message: '', data: agents.map(toNode) });
});

// GET /api/recent —— 省略 uuid 时返回空数组（避免 /api/recent/ 触发 404，便于调试）。
router.get('/recent', guard, (req, res) => {
  res.json({ status: 'success', message: '', data: [] });
});

// GET /api/recent/:uuid —— 最近实时指标（取最新一条，嵌套结构）。
router.get('/recent/:uuid', guard, (req, res) => {
  const a = db.getAgent(req.params.uuid);
  if (!a) return res.json({ status: 'success', message: '', data: [] });
  const rt = toRealtime(db.getLatestMetric(a.id));
  res.json({ status: 'success', message: '', data: rt ? [rt] : [] });
});

// GET /api/node/:uuid —— 社区主题 node detail 取数（参考 Komari getNode 形状）
// 返回 node 基础信息 + 实时 realtime + 历史 history（最近一段时间序列），供社区皮肤详情页渲染。
router.get('/node/:uuid', guard, (req, res) => {
  const a = db.getAgent(req.params.uuid);
  if (!a) return res.json({ status: 'error', message: 'node not found', data: null });
  const node = toNode(a);
  const latest = db.getLatestMetric(a.id);
  const rt = toRealtime(latest);
  const sec = RANGES_C[req.query.range] || 21600;
  const hist = db.getMetrics(a.id, Date.now() - sec * 1000);
  const history = hist.map(m => ({
    created_at: new Date(m.ts).toISOString(),
    cpu: Number(m.cpu) || 0,
    ram: Number(m.mem_used) || 0,
    ram_total: Number(m.mem_total) || 0,
    swap: Number(m.swap_used) || 0,
    swap_total: Number(m.swap_total) || 0,
    disk: Number(m.disk_used) || 0,
    disk_total: Number(m.disk_total) || 0,
    up: Number(m.net_tx_rate) || 0,
    down: Number(m.net_rx_rate) || 0,
    load1: Number(m.load1) || 0,
    temp: Number(m.temp) || 0
  }));
  res.json({
    status: 'success', message: '',
    data: { node, realtime: rt, history, online: isOnline(a) }
  });
});

// GET /api/me —— 官方主题初始化请求登录态（不加 guard，public_enabled=false 也需返回）
// 与 Komari 原版 /api/me（jsonRpc.WithRaw）保持一致：返回扁平对象，不包裹 {status,message,data}。
// 主题端 AccountContext 直接把整个响应体当 account 使用：account = await resp.json()，
// 故必须扁平返回，否则 account.logged_in 为 undefined。
router.get('/me', (req, res) => {
  res.json({ logged_in: false, username: '', sso_id: '', sso_type: '', uuid: '' });
});

// POST /api/rpc2 —— 社区主题 JSON-RPC 网关
// 使用延迟 require 避免 compat.js <-> compat-rpc.js 循环依赖
router.post('/rpc2', (req, res) => {
  const { rpcMiddleware } = require('./compat-rpc');
  rpcMiddleware(req, res);
});

module.exports = { router, snapshot, publicOpen, toNode, toRealtime, isOnline, getNodesLatestStatus };
