'use strict';
// 第三方主题兼容 API 层（PoC）
// 让 diting 的公开数据以社区主题所期望的接口形状暴露，
// 从而使「适配路线」可行：把社区主题的前端请求层指向本服务即可复用。
// 仅暴露只读、脱敏数据，且同样受 ui_settings.public_enabled 开关约束（与 /api/public/* 一致）。
const express = require('express');
const router = express.Router();
const db = require('./db');
const { asyncHandler } = require('./util');
// 审查 C4：公开兼容层的重聚合（720h 全窗、未认证即可触发）移 worker 线程
const { heavyQuery } = require('./heavy-db');

// 在线判定与离线阈值统一走 src/online.js：取值链「节点覆盖 > 分组覆盖 > 全局」，
// 与告警同源。改造前这里只看 OFFLINE_THRESHOLD_SEC env，一旦面板把阈值调成非默认值、
// 或给某节点设了覆盖，就会出现「兼容接口说在线、告警说离线」的自相矛盾。
const online = require('./online');

// 历史曲线时间窗（与 api.js RANGES 保持一致）
const RANGES_C = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };

// 公开历史接口结果缓存（30s，与 api.js 的 sparkline 缓存同思路）。
// /records/load 与 /records/ping 无需登录，且最坏情况是 720h 全库窗口扫描（秒级），
// 若不缓存，前端并发刷新或几个访客同时打开就能把服务端拖垮（DoS 级放大器）。
const recordsCache = new Map();   // key -> { ts, data }
const RECORDS_CACHE_TTL = 30000;
const RECORDS_CACHE_MAX = 200;    // key 由查询参数组合而成，必须限制总量，防止被枚举撑爆内存
// 全量（不带 uuid）查询时的每节点采样点数：按「窗口内实际有数据的节点数」分摊，
// 给 2 倍余量并设下限 20。不能按全部节点数分摊——62 台里 24h 内只有 1 台在报，
// 按 62 摊会把这 1 台压到 34 点（优化前是 1000 点），曲线直接失真。
// 上限仍是 maxCount：单节点场景给满，多节点场景避免 N×1000 行的传输浪费。
function perAgentPoints(maxCount, since) {
  const n = Math.max(1, db.countActiveAgents(since));
  return Math.min(maxCount, Math.max(20, Math.ceil(maxCount / n) * 2));
}

function cachedRecords(key, build) {
  const hit = recordsCache.get(key);
  if (hit && Date.now() - hit.ts < RECORDS_CACHE_TTL) return hit.data;
  const data = build();
  if (recordsCache.size >= RECORDS_CACHE_MAX) recordsCache.clear();
  recordsCache.set(key, { ts: Date.now(), data });
  return data;
}
// 审查 C4：异步版——build 内部的重聚合走 worker 线程（公开端点最坏 720h 全库
// 扫描，同步执行会阻塞事件循环数秒，期间 /report 与告警一并挂起）。
async function cachedRecordsAsync(key, build) {
  const hit = recordsCache.get(key);
  if (hit && Date.now() - hit.ts < RECORDS_CACHE_TTL) return hit.data;
  const data = await build();
  if (recordsCache.size >= RECORDS_CACHE_MAX) recordsCache.clear();
  recordsCache.set(key, { ts: Date.now(), data });
  return data;
}

// ISO 3166-1 alpha-2 -> 国旗 emoji（region 字段用国旗表情）
function flagEmoji(iso) {
  if (!iso || iso.length !== 2) return '';
  const cc = iso.toUpperCase();
  const A = 0x1F1E6;
  const base = 'A'.charCodeAt(0);
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(A + cc.charCodeAt(0) - base) + String.fromCodePoint(A + cc.charCodeAt(1) - base);
}

// 公开接口是否透出业务字段（与 /api/public/* 同源开关 ui_settings.public_show_business）
function businessVisible() {
  const ui = db.getUiSettings();
  return ui.public_show_business !== false;
}

// 计费口径换算（diting ↔ Komari，见 plans/2026-10-26-komari-compat-fields.md §3.1）：
//   price: diting 0（未设置）→ Komari -1（主题显示「—」）；diting <0（白嫖）→ 0；diting >0 原值
//   cycle: diting null/空/非数 → 30；0（白嫖/一次性）必须原样保留，不能被 || 30 吞掉
function komariPrice(a) {
  const p = Number(a.price);
  if (!Number.isFinite(p) || p === 0) return -1;
  return p < 0 ? 0 : p;
}
function komariBillingCycle(a) {
  const raw = a.billing_cycle;
  if (raw === null || raw === undefined || raw === '') return 30;
  const c = Number(raw);
  return Number.isFinite(c) ? c : 30;
}

// diting agent -> 社区主题 node 列表项（/api/nodes）
function toNode(a, showBusiness, octx) {
  const m = db.getLatestMetric(a.id) || {};
  const show = showBusiness === undefined ? businessVisible() : showBusiness !== false;
  return {
    uuid: a.id,
    name: a.name,
    cpu_name: '',
    virtualization: '',
    arch: '',
    cpu_cores: Number(a.cores) || 0,
    cpu_physical_cores: 0,
    os: a.os || '',
    // 内核版本是红线字段（diting 不采集）：此前错误地用 hostname 冒充，主题会把它当内核版本显示。
    // 保持空串，绝不回填 hostname。
    kernel_version: '',
    gpu_name: 'None',
    region: flagEmoji(a.country),
    mem_total: Number(m.mem_total) || 0,
    swap_total: Number(m.swap_total) || 0,
    disk_total: Number(m.disk_total) || 0,
    weight: 0,
    // 业务字段：受 public_show_business 控制，关闭时回退到主题约定的「未设置」值
    price: show ? komariPrice(a) : -1,
    billing_cycle: show ? komariBillingCycle(a) : 30,
    // 协议占位：仅表示「支持该标记」，diting 没有自动续费周期任务。
    // 主题据此渲染「自动续费」徽标，不代表服务端会真的自动延期。
    auto_renewal: true,
    currency: show ? (a.currency || '¥') : '$',
    // 真实到期时间属业务字段，受 public_show_business 控制；关闭时回退到主题约定的"未设置"零值
    expired_at: show && a.expire_at ? a.expire_at : '0001-01-01T00:00:00.0000000+00:00',
    group: a.grp || '',
    tags: '',
    hidden: false,
    public_remark: a.note || '',
    // monthly_quota_gb 为 GiB 口径（与 alerts/前端/AI 一致），对主题边界换算成字节。
    traffic_limit: Number(a.monthly_quota_gb) > 0 ? Math.round(a.monthly_quota_gb * 1024 * 1024 * 1024) : 0,
    traffic_limit_type: 'max',
    created_at: new Date(a.created_at).toISOString(),
    updated_at: new Date(a.last_seen || a.created_at).toISOString(),
    online: online.isOnline(a, undefined, octx),
    ttl: online.onlineTtl(a, undefined, octx)
  };
}

// diting metric -> 社区主题实时嵌套结构（/api/recent/{uuid} 与 WS 同构）
// online/ttl 由调用方注入（toRealtime 不知 agent 心跳），故此处不填，
// 由 snapshot()/recent 路由在组装时附加，避免重复计算。
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
    process: Number(m.process_count) || 0,
    message: '',
    updated_at: new Date(m.ts).toISOString()
  };
}

function publicOpen() {
  const ui = db.getUiSettings();
  return ui.public_enabled !== false;
}

// 实时状态映射（供 JSON-RPC /api/rpc2 的 common:getNodesLatestStatus 使用）
// 注意：这里返回的是 Komari 原版 recordLike 扁平格式（含 online 字段），
// 而非 toRealtime 的嵌套结构。主题 updateNodeStatuses 期望扁平字段：
// L(node, status) => { online, time, cpu, ram, ram_total, swap, ... }
function getNodesLatestStatus() {
  if (!publicOpen()) return {};
  const agents = db.getMonitoredAgents();
  // 批量场景一次性预取阈值上下文（3 次查询，与节点数无关），避免逐节点 N×2 查库
  const octx = online.buildCtx();
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
      temp: Number(m.temp) || 0,
      disk: Number(m.disk_used) || 0,
      disk_total: Number(m.disk_total) || 0,
      net_in: Number(m.net_rx_rate) || 0,
      net_out: Number(m.net_tx_rate) || 0,
      net_total_up: Number(m.net_tx_month) || 0,
      net_total_down: Number(m.net_rx_month) || 0,
      process: Number(m.process_count) || 0,
      connections: 0,
      connections_udp: 0,
      online: online.isOnline(a, undefined, octx),
      ttl: online.onlineTtl(a, undefined, octx),
      uptime: Number(m.uptime) || 0
    };
  }
  return data;
}

// 全量快照（供 WebSocket /api/clients 使用，结构与社区主题一致）。
// 在每个 node 实时结构里透出 online 布尔与 ttl（精确心跳语义），
// 社区主题既可用 online 数组也可逐节点判断，兼容官方两种取数方式。
function snapshot() {
  if (!publicOpen()) return { data: { online: [], data: {} }, status: 'success' };
  const agents = db.getMonitoredAgents();
  const octx = online.buildCtx();
  const onlineIds = [];
  const data = {};
  for (const a of agents) {
    const on = online.isOnline(a, undefined, octx);
    if (on) onlineIds.push(a.id);
    const rt = toRealtime(db.getLatestMetric(a.id));
    if (rt) data[a.id] = { ...rt, online: on, ttl: online.onlineTtl(a, undefined, octx) };
  }
  return { data: { online: onlineIds, data }, status: 'success' };
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
      theme_settings: {},
      // 注意：前端 LoadChart/PingChart 的 Y()/Pe()/Qe() 期望 cards 为【短名字符串数组】
      // （如 "cpu"/"load"/"memory"/"disk"/"network"/"ping"），而非 {name} 对象数组。
      // 对象数组会导致 includes/indexOf 永远 false，从而所有卡片不渲染。
      chartDashboardTemplate: {
        // gpu / gpuMemory / connections 已移除：diting 不采集（红线），这三张卡永远没有
        // series（compat-metrics.js 刻意只断映射不删定义），保留只会让主题渲染空图，
        // 用户还得改主题才能去掉。process / temperature 有真实数据源，保留。
        cards: [
          'cpu', 'load', 'memory', 'disk', 'network',
          'temperature', 'process', 'traffic', 'ping', 'pingLoss'
        ]
      }
    }
  });
});

// GET /api/version 已移至 server.js（注册于本 router 之前）。此前这里有一条
// 同名静态占位路由，会把 server.js 的真实版本端点静默遮蔽成死代码；现在由
// server.js 单点提供「主题兼容信封 + G5 版本披露收敛」，本文件不再重复注册。

// GET /api/nodes —— 节点基础信息列表（不含实时负载）
router.get('/nodes', guard, (req, res) => {
  const agents = db.getMonitoredAgents();
  // 注意：不能用 agents.map(toNode)——map 会把数组下标当作第二个参数 showBusiness 传入，
  // 下标 0 会被当成 false，导致第一个节点的业务字段被静默隐藏。
  const show = businessVisible();
  const octx = online.buildCtx();
  res.json({ status: 'success', message: '', data: agents.map((a) => toNode(a, show, octx)) });
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
  if (!rt) return res.json({ status: 'success', message: '', data: [] });
  const on = online.isOnline(a);
  res.json({ status: 'success', message: '', data: [{ ...rt, online: on, ttl: online.onlineTtl(a) }] });
});

// GET /api/records/load —— 负载历史（官方主题详情页历史曲线依赖）。
// 参数：uuid / client（节点）、hours（默认24）、max_count（默认1000）。
function toLoadRecord(m) {
  return {
    client: m.agent_id,
    time: new Date(m.ts).toISOString(),
    cpu: Number(m.cpu) || 0,
    ram: Number(m.mem_used) || 0,
    ram_total: Number(m.mem_total) || 0,
    swap: Number(m.swap_used) || 0,
    swap_total: Number(m.swap_total) || 0,
    load: Number(m.load1) || 0,
    disk: Number(m.disk_used) || 0,
    disk_total: Number(m.disk_total) || 0,
    net_in: Number(m.net_rx_rate) || 0,
    net_out: Number(m.net_tx_rate) || 0,
    net_total_up: Number(m.net_tx_month) || 0,
    net_total_down: Number(m.net_rx_month) || 0,
    connections: 0
  };
}
router.get('/records/load', guard, asyncHandler(async (req, res) => {
  const uuid = req.query.uuid || req.query.client;
  const hours = Math.min(Number(req.query.hours) || 24, 720);
  const maxCount = Math.min(Number(req.query.max_count) || 1000, 5000);
  // 游客可直接访问，且最坏情况是 720h 全库窗口扫描；30s 缓存避免并发刷新把服务端打挂
  // 审查 C4：缓存未命中时的重聚合移 worker 线程（否则数秒阻塞事件循环）
  const payload = await cachedRecordsAsync(`load|${uuid || '*'}|${hours}|${maxCount}`, async () => {
    const since = Date.now() - hours * 3600 * 1000;
    // M-02：SQL 层采样 + 只取负载列（不含 probes/disks 大 JSON 字段）。
    // 指定节点走单节点采样；不指定时按节点数分摊每节点点数（响应最终只保留 maxCount 条，
    // 每节点各取 1000 点纯属浪费——61 台 ⇒ 6 万行 324KB，降到 ~750 行后 720h 从 21s 到 2.2s）。
    const sampled = uuid
      ? await heavyQuery('loadOne', uuid, since, maxCount)
      : await heavyQuery('loadAll', since, perAgentPoints(maxCount, since));
    const rows = sampled.sort((a, b) => a.ts - b.ts).slice(-maxCount);
    const records = rows.map(toLoadRecord);
    return { status: 'success', message: '', count: records.length, records };
  });
  res.json(payload);
}));

// GET /api/records/ping —— 延迟历史（官方主题延迟图依赖）。
// diting 无独立 ping task 表，网络质量自测结果存于 metrics.probes(JSON)。
// 转译为官方结构：每个被探测目标为一个 task，value=该时刻延迟(ms)，loss=丢包率。
router.get('/records/ping', guard, asyncHandler(async (req, res) => {
  const uuid = req.query.uuid || req.query.client;
  const hours = Math.min(Number(req.query.hours) || 24, 720);
  const maxCount = Math.min(Number(req.query.max_count) || 1000, 5000);
  // 与 /records/load 同理：游客可直连，720h 全量最坏要扫百万行，30s 缓存兜底
  // 审查 C4：重聚合移 worker 线程
  const payload = await cachedRecordsAsync(`ping|${uuid || '*'}|${hours}|${maxCount}`, async () => {
    const since = Date.now() - hours * 3600 * 1000;
    // M-02：只取 ts+probes 两列并在 SQL 层采样。指定节点用单节点版，
    // 否则一次 SQL 跨节点采样（probesAll），避免 per-agent 循环 N 次扫索引。
    const probeRows = uuid
      ? db.getMetricsProbesOne(uuid, since, maxCount)
      : await heavyQuery('probesAll', since, Math.max(200, perAgentPoints(maxCount, since)));
    const tasks = new Map();      // task_id -> {id,name,interval,loss}
    const records = [];           // {task_id,time,value}
    let tid = 0;
    for (const m of probeRows) {
      let probes = null;
      try { probes = m.probes ? JSON.parse(m.probes) : null; } catch (_) { probes = null; }
      if (!probes || typeof probes !== 'object') continue;
      // M-01：diting 实际入库的是「对象」格式（validate.js 校验并写为
      // { "<目标名>": { ms, ok, loss } }，见 src/validate.js）。此前这里只认数组
      // （Array.isArray），对象被整体跳过 → 该接口恒返回 count:0 / tasks:[]，
      // 社区主题的延迟图永远是空的。现同时兼容两种格式，键名即任务名。
      const items = Array.isArray(probes)
        ? probes.map((p) => ({
            name: p.target || p.host || 'unknown',
            value: p.latency != null ? Number(p.latency) : (p.avg != null ? Number(p.avg) : null),
            loss: Number(p.loss) || 0,
          }))
        : Object.entries(probes).map(([name, v]) => ({
            name,
            value: v && v.ms != null ? Number(v.ms) : null,
            loss: v && v.loss != null ? Number(v.loss) : (v && v.ok === true ? 0 : 100),
            // F4 透传：社区主题不消费则无害；消费时可区分 tcp/http、状态码与证书剩余天数。
            type: v && v.type === 'http' ? 'http' : 'tcp',
            code: v && Number.isInteger(v.code) ? v.code : null,
            cert_days: v && typeof v.cert_days === 'number' ? v.cert_days : null,
          }));
      for (const it of items) {
        if (it.value == null || !Number.isFinite(it.value)) continue;
        let t = tasks.get(it.name);
        if (!t) { t = { id: ++tid, name: it.name, interval: 1, loss: it.loss || 0, type: it.type || 'tcp', code: it.code ?? null, cert_days: it.cert_days ?? null }; tasks.set(it.name, t); }
        records.push({ task_id: t.id, time: new Date(m.ts).toISOString(), value: it.value });
      }
    }
    records.sort((a, b) => new Date(a.time) - new Date(b.time));
    return {
      status: 'success', message: '', count: records.length,
      records: records.slice(-maxCount),
      tasks: [...tasks.values()]
    };
  });
  res.json(payload);
}));

// GET /api/node/:uuid —— 社区主题 node detail 取数（参考 Komari getNode 形状）
// 返回 node 基础信息 + 实时 realtime + 历史 history（最近一段时间序列），供社区皮肤详情页渲染。
router.get('/node/:uuid', guard, (req, res) => {
  const a = db.getAgent(req.params.uuid);
  if (!a) return res.json({ status: 'error', message: 'node not found', data: null });
  const node = toNode(a, businessVisible());
  const latest = db.getLatestMetric(a.id);
  const rt = toRealtime(latest);
  const sec = RANGES_C[req.query.range] || 21600;
  // M-02：历史曲线同样走 SQL 层采样，且只取负载列（此前 7d 单节点全量拉取）
  const hist = db.getMetricsLoadOne(a.id, Date.now() - sec * 1000, 1000);
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
    data: { node, realtime: rt, history, online: online.isOnline(a) }
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

module.exports = { router, snapshot, publicOpen, toNode, toRealtime, isOnline: online.isOnline, getNodesLatestStatus };
