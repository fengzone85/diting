'use strict';
// 公开视图与节点域共用的纯函数 / 只读缓存（P2-1 拆分：零行为变更）。
// 依赖方向固定：本文件 → ../db，不得 require 任何域路由文件。

const db = require('../db');

// 展示用 hostname 脱敏：带域名时只取最左标签（二级名），隐去后续域名；
// 纯 IP / 无点则原样，避免误截。例：pt5.521.be -> pt5；192.168.1.10 -> 原样。
function shortHost(h) {
  if (!h) return '';
  h = String(h).trim();
  const i = h.indexOf('.');
  if (i < 0) return h;                            // 无点（如 Feng / localhost）原样
  const suffix = h.slice(i + 1);
  if (/[a-zA-Z]/.test(suffix)) return h.slice(0, i); // 后缀含字母 => 域名，取二级名
  return h;                                        // 后缀纯数字 => 疑似 IP，原样保留
}

// 把 metrics.disks（TEXT 存储的 JSON 数组）安全解析为数组，供前端多盘渲染。
function parseDisks(s) {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

// ---- Admin: metrics time-series ----
// 4h/12h：对齐玻璃拟态设计的负载图（4 小时）与延迟图（12 小时）档位。
const RANGES = { '1h': 3600, '4h': 14400, '6h': 21600, '12h': 43200, '24h': 86400, '7d': 604800, '30d': 2592000 };
// 各档默认点数（体检 L-6）：原先走 getMetrics(metricsRange=SELECT *) 全量拉取，
// 30d 约 12.9 万行且含 probes/disks 大 JSON。改用 SQL 层均匀采样（保留首尾点）。
const RANGE_POINTS = { '1h': 180, '4h': 240, '6h': 360, '12h': 360, '24h': 360, '7d': 360, '30d': 360 };

function publicDisabled(res) { return res.status(403).json({ error: 'public view disabled' }); }

// F7：30 天在线率（公开列表用）。聚合要扫 online_sessions，100 台规模下没必要每个
// 请求重算 → 30s 进程内缓存，与 sparklines / records 缓存同口径。
const UPTIME_CACHE_TTL = 30000;
let uptimeCache = { ts: 0, data: {} };
function getUptime30d() {
  const now = Date.now();
  if (now - uptimeCache.ts < UPTIME_CACHE_TTL) return uptimeCache.data;
  try {
    uptimeCache = { ts: now, data: db.onlineUptimeAll(now - 30 * 86400000, now) };
  } catch (e) {
    // 老库无 online_sessions 时不影响公开列表主流程
    uptimeCache = { ts: now, data: {} };
  }
  return uptimeCache.data;
}


// 自定义时间窗解析（sparklines / probes 共用，避免两处口径漂移）。
// 显式报错而非静默回落默认 range：传了非法参数却看到 7d 数据，比 400 更误导。
const MAX_CUSTOM_WINDOW_MS = 30 * 86400000;
function parseCustomWindow(query) {
  const hasStart = typeof query.start === 'string' && query.start !== '';
  const hasEnd = typeof query.end === 'string' && query.end !== '';
  if (!hasStart && !hasEnd) return null;
  if (!hasStart || !hasEnd) return { error: 'invalid_range' };
  const since = Date.parse(query.start);
  const until = Date.parse(query.end);
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) {
    return { error: 'invalid_range' };
  }
  if (until - since > MAX_CUSTOM_WINDOW_MS) return { error: 'range_too_large' };
  return { since, until };
}


// 后端降采样开关（对齐参考面板 downsample/max_points 契约）：
//   PROBES_DOWNSAMPLE=1（默认）启用后端时间桶聚合 + 每 label 点数上限；
//   =0 关闭则原样返回桶内原始点（点数可能很大，供前端自行处理）。
//   PROBES_MAX_POINTS：每 label 点数硬上限，默认 5000，可调（上限钳到 50000）。
const PROBES_DOWNSAMPLE = process.env.PROBES_DOWNSAMPLE !== '0';
const PROBES_MAX_POINTS = (() => {
  const n = Number(process.env.PROBES_MAX_POINTS);
  return Number.isFinite(n) && n > 0 ? Math.min(50000, Math.floor(n)) : 5000;
})();

// 将任意输入钳为正整数，非法/越界返回 null
function clampInt(v, min = 1, max = 50000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}


// ---- sparklines 后端降采样（对齐参考面板 max_points 契约）----
// 卡片迷你图只需 ~60 点，磁盘耗尽预测需较长序列（~2000 点足够）。
// 全量 30d 单节点 9.5 万点，100 台规模下公开 sparklines 无 id 全量查询会雪崩（DoS 级）。
// 故按 range 给每 agent 设定点数上限，做时间桶聚合，避免传输/序列化灾难。
const SPARK_MAX_POINTS = {
  '1h': 300, '4h': 450, '6h': 600, '12h': 800, '24h': 1000, '7d': 1500, '30d': 2000
};
function sparkMaxPoints(range) {
  return SPARK_MAX_POINTS[range] || 2000;
}

// rows: [{ts, agent_id, ...metrics}]，按 agent_id 分组后组内时间桶降采样到 maxPoints。
// 桶内取最后一个点（时序曲线降采样用 last 即可，磁盘预测线性外推同样适用）。
function downsampleSparklines(rows, maxPoints) {
  const byAgent = {};
  for (const r of rows) {
    (byAgent[r.agent_id] || (byAgent[r.agent_id] = [])).push(r);
  }
  const out = {};
  for (const [agentId, arr] of Object.entries(byAgent)) {
    if (arr.length <= maxPoints) {
      out[agentId] = arr;
      continue;
    }
    const span = arr[arr.length - 1].ts - arr[0].ts;
    const bucket = Math.max(1, Math.ceil(span / maxPoints)); // 以 maxPoints 反推桶宽
    const map = new Map();
    const order = [];
    for (const r of arr) {
      const key = Math.floor(r.ts / bucket) * bucket;
      if (!map.has(key)) { map.set(key, r); order.push(key); }
      else map.set(key, r); // 同桶取最后一个点
    }
    out[agentId] = order.map(k => map.get(k));
  }
  return out;
}


module.exports = {
  shortHost,
  parseDisks,
  RANGES,
  RANGE_POINTS,
  publicDisabled,
  getUptime30d,
  parseCustomWindow,
  PROBES_DOWNSAMPLE,
  PROBES_MAX_POINTS,
  clampInt,
  sparkMaxPoints,
  downsampleSparklines,
};
