// summarizer.js —— 纯本地统计聚合层
//
// 职责：从 metrics/agents 表读取原始时序，聚合为 AI 可读的结构化摘要。
// 关键约束：本模块【绝不调用任何模型】，只做确定性数学计算（avg/p95/峰值/超阈值时长/
// 磁盘线性外推天数/内存斜率）。它是 AI 服务的【降级基底】：即便 LLM 不可用，
// 这些统计数字本身也能拼成一份可读日报（见 report.js 的降级路径）。
//
// 复用 db.getMetricsAll（全量 sparkline，db.js:174）与 db.getAgents，避免逐台 N+1 查询。

const db = require('../db');

// 数值安全化：剔除 null/undefined/NaN，避免污染统计。
function nums(arr) {
  const out = [];
  for (const v of arr) if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  return out;
}

// 基础统计量。空数组返回 null，由调用方决定如何呈现。
function stats(arr) {
  const a = nums(arr);
  const n = a.length;
  if (!n) return { count: 0, avg: null, max: null, min: null, p95: null };
  let sum = 0, max = a[0], min = a[0];
  for (const v of a) { sum += v; if (v > max) max = v; if (v < min) min = v; }
  const sorted = a.slice().sort((x, y) => x - y);
  // p95：取升序后第 95% 位置的值（nearest-rank 法）
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
  return { count: n, avg: +(sum / n).toFixed(2), max: +max.toFixed(2), min: +min.toFixed(2), p95: +p95.toFixed(2) };
}

// 超阈值分钟数：按采样间隔把样本数换算成分钟。
// metrics 上报间隔默认 15s（AGENT_INTERVAL），故 minutes ≈ count * (interval/60)。
function overThresholdMinutes(arr, threshold, intervalSec) {
  const a = nums(arr);
  let cnt = 0;
  for (const v of a) if (v >= threshold) cnt++;
  return Math.round(cnt * (intervalSec / 60));
}

// 磁盘线性外推：用首末两点斜率估算达到 90% 所需天数。
// 返回 null 表示数据不足或当前已 ≥90%（无可推算空间）。注意线性外推对磁盘增长并不可靠，
// 此值仅作参考，最终判断交由 AI 标注「概率性」。
function diskFullDays(rows) {
  const pts = [];
  for (const r of rows) {
    if (typeof r.disk_pct === 'number' && Number.isFinite(r.disk_pct) && r.ts) {
      pts.push({ t: r.ts, p: r.disk_pct });
    }
  }
  if (pts.length < 2) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const dtDays = (last.t - first.t) / 86400000;
  if (dtDays <= 0) return null;
  const dp = last.p - first.p;
  if (dp <= 0) return null;          // 未增长或下降，无法（也不必）外推
  if (last.p >= 90) return null;      // 已达阈值
  const pctPerDay = dp / dtDays;
  const daysTo90 = (90 - last.p) / pctPerDay;
  return Math.round(daysTo90);
}

// 内存斜率：首末差值（百分点），正=上升（疑似增长），用于 AI 判断泄漏趋势。
function memSlope(rows) {
  const pts = nums(rows.map(r => r.mem_pct));
  if (pts.length < 2) return null;
  return +(pts[pts.length - 1] - pts[0]).toFixed(2);
}

// 单个 agent 的聚合摘要。
function summarizeAgent(agent, rows, opts) {
  const intervalSec = Number(opts && opts.intervalSec) || 15;
  const offlineSec = Number(opts && opts.offlineSec) || 60;
  const cpuAlert = Number(opts && opts.cpuAlert) || 90;
  const memAlert = Number(opts && opts.memAlert) || 90;
  const now = Date.now();
  const online = agent.last_seen && (now - agent.last_seen) < offlineSec * 1000;

  const cpuStats = stats(rows.map(r => r.cpu));
  const memStats = stats(rows.map(r => r.mem_pct));
  const diskStats = stats(rows.map(r => r.disk_pct));
  const loadStats = stats(rows.map(r => r.load1));
  const swapStats = stats(rows.map(r => r.swap_pct));

  // 末样本（最新一份）用于「当前状态」
  const latest = rows.length ? rows[rows.length - 1] : null;

  return {
    id: agent.id,
    name: agent.name,
    online,
    samples: rows.length,
    cpu: {
      avg: cpuStats.avg, max: cpuStats.max, p95: cpuStats.p95,
      over_threshold_minutes: overThresholdMinutes(rows.map(r => r.cpu), cpuAlert, intervalSec)
    },
    memory: {
      avg: memStats.avg, max: memStats.max, p95: memStats.p95,
      slope_pct: memSlope(rows),
      over_threshold_minutes: overThresholdMinutes(rows.map(r => r.mem_pct), memAlert, intervalSec)
    },
    disk: {
      current_pct: latest ? (typeof latest.disk_pct === 'number' ? +latest.disk_pct.toFixed(2) : null) : null,
      used_gb: latest && latest.disk_used ? +(latest.disk_used / 1073741824).toFixed(2) : null,
      total_gb: latest && latest.disk_total ? +(latest.disk_total / 1073741824).toFixed(2) : null,
      estimated_full_days: diskFullDays(rows)
    },
    load: { avg1: loadStats.avg },
    swap: { avg: swapStats.avg, max: swapStats.max },
    network: {
      rx_rate_avg: stats(rows.map(r => r.net_rx_rate)).avg,
      tx_rate_avg: stats(rows.map(r => r.net_tx_rate)).avg
    }
  };
}

// 全量聚合：默认取过去 24h 数据，按 agent 分组聚合。
// 返回 { generated_at, period, agent_count, online_count, agents: [...] }
function summarize(options) {
  const opts = options || {};
  const periodHours = Number(opts.periodHours) || 24;
  const sinceTs = Date.now() - periodHours * 3600000;

  const ui = db.getUiSettings();
  const alertCfg = (ui && ui.alert) || {};
  const intervalSec = Number(process.env.AGENT_INTERVAL || 15);
  const offlineSec = Number(alertCfg.offline_sec || process.env.OFFLINE_THRESHOLD_SEC || 60);
  const cpuAlert = Number(alertCfg.cpu_pct || process.env.ALERT_CPU_PCT || 90);
  const memAlert = Number(alertCfg.mem_pct || process.env.ALERT_MEM_PCT || 90);

  const agents = db.getAgents();
  // 一次拉全量再分组，避免逐台查询（同 /agents/sparklines 模式，api.js:258）
  const rows = db.getMetricsAll(sinceTs);
  const byAgent = {};
  for (const r of rows) {
    (byAgent[r.agent_id] || (byAgent[r.agent_id] = [])).push(r);
  }

  const sumOpts = { intervalSec, offlineSec, cpuAlert, memAlert };
  const out = agents.map(a => summarizeAgent(a, byAgent[a.id] || [], sumOpts));
  const onlineCount = out.filter(s => s.online).length;

  return {
    generated_at: new Date().toISOString(),
    period: `${periodHours}h`,
    agent_count: agents.length,
    online_count: onlineCount,
    offline_count: agents.length - onlineCount,
    thresholds: { cpu_pct: cpuAlert, mem_pct: memAlert, offline_sec: offlineSec },
    agents: out
  };
}

module.exports = { summarize, summarizeAgent, stats };
