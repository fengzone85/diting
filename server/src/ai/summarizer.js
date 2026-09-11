// summarizer.js —— 纯本地统计聚合层
//
// 职责：从 metrics/agents 表读取原始时序，聚合为 AI 可读的结构化摘要。
// 关键约束：本模块【绝不调用任何模型】，只做确定性数学计算（avg/p95/峰值/超阈值时长/
// 磁盘趋势/内存斜率）。它是 AI 服务的【降级基底】：即便 LLM 不可用，
// 这些统计数字本身也能拼成一份可读日报（见 report.js 的降级路径）。
//
// 数学部分已抽到 stats.js（零 DB 依赖，便于单测）；本文件只负责取数与组装。
//
// 【磁盘趋势】不再用 24h 首末两点外推（同一台机器换个窗口就 2 天 ↔ 7.6 天跳变，
// 且当前 24h 末点回落后旧算法直接返回 null → 日报里该项根本不出现）：
//   ① 单独拉一条 ≤14 天、1h 桶的轻量序列（仅 ts + disk_pct，**不进 prompt**）；
//   ② stats.diskTrend 用「等分 6 段斜率中位数 + 近 24h 桶中位分子」估计，并给出跨窗口区间与置信度；
//   ③ `AI_TREND_DAYS=0` 时回退旧 24h 算法（保留一键回退能力）。

const db = require('../db');
const { daysUntil, cycleLabel } = require('../util');
const { stats, overThresholdMinutes, diskFullDays, diskTrend, memSlope } = require('./stats');

const DEFAULT_AGENT_INTERVAL = 20;   // 秒；与 agent/agent.py 的 INTERVAL 默认值保持一致
const AI_TREND_FETCH_DAYS = 14;      // 趋势查询最多回看的天数（成本上限：14d ≈1s）
const AI_TREND_BUCKET_MS = 3600000;  // 1h 桶 → 14d ≈336 点/台（桶宽只影响输出分辨率，不影响扫描成本）

// 趋势窗口天数：0=关闭（回退 24h 算法）；默认 7；clamp 到 [2, 14] 且不超过 metrics 保留天数。
function resolveTrendDays() {
  const raw = Number(process.env.AI_TREND_DAYS);
  if (raw === 0) return 0;
  const want = Number.isFinite(raw) && raw > 0 ? raw : 7;
  const retention = Number(db.getRetentionDays()) || 30;
  return Math.max(2, Math.min(AI_TREND_FETCH_DAYS, Math.round(want), retention));
}

// 组装 disk 字段。trendDays>0 且序列足够时走 diskTrend，否则回退旧 24h 首末两点算法。
function buildDisk(latest, rows, series, trendDays) {
  const out = {
    current_pct: latest && typeof latest.disk_pct === 'number' ? +latest.disk_pct.toFixed(2) : null,
    used_gb: latest && latest.disk_used ? +(latest.disk_used / 1073741824).toFixed(2) : null,
    total_gb: latest && latest.disk_total ? +(latest.disk_total / 1073741824).toFixed(2) : null,
    estimated_full_days: null,
    estimated_full_days_range: null,
    slope_pct_per_day: null,
    trend_confidence: null,
    trend_window_days: null,
    trend_note: 'fallback_24h'
  };

  const t = trendDays > 0 && Array.isArray(series) && series.length
    ? diskTrend(series, { maxDays: trendDays })
    : null;
  if (t) {
    out.trend_note = t.note;
    // 与预测同源：current_pct 改用「近 24h 桶中位」，避免「当前 73.1% + 斜率×天数 ≠ 90%」的自相矛盾
    if (typeof t.level === 'number') out.current_pct = +t.level.toFixed(2);
  }
  if (t && t.note === 'ok') {
    out.estimated_full_days = Math.round(t.days_to_90);
    out.estimated_full_days_range = t.range
      ? [Math.round(t.range[0]), t.range[1] == null ? null : Math.round(t.range[1])]
      : null;
    out.slope_pct_per_day = +t.slope_pct_per_day.toFixed(3);
    out.trend_confidence = t.confidence;
    out.trend_window_days = +t.window_days.toFixed(1);
    return out;
  }
  // 回退：旧 24h 首末两点（AI_TREND_DAYS=0 / 数据不足 / 未增长 / 已达阈值）
  out.estimated_full_days = diskFullDays(rows);
  return out;
}

// 单个 agent 的聚合摘要。
function summarizeAgent(agent, rows, opts) {
  const o = opts || {};
  const intervalSec = Number(o.intervalSec) || DEFAULT_AGENT_INTERVAL;
  const offlineSec = Number(o.offlineSec) || 60;
  const cpuAlert = Number(o.cpuAlert) || 90;
  const memAlert = Number(o.memAlert) || 90;
  const now = Date.now();
  const online = agent.last_seen && (now - agent.last_seen) < offlineSec * 1000;

  const cpuStats = stats(rows.map(r => r.cpu));
  const memStats = stats(rows.map(r => r.mem_pct));
  const loadStats = stats(rows.map(r => r.load1));
  const swapStats = stats(rows.map(r => r.swap_pct));

  // 末样本（最新一份）用于「当前状态」
  const latest = rows.length ? rows[rows.length - 1] : null;
  // 7/14 天桶序列（由 summarize 一次查出后按 agent 分组下发）
  const series = o.diskSeriesByAgent ? o.diskSeriesByAgent[agent.id] : null;

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
    disk: buildDisk(latest, rows, series, Number(o.trendDays) || 0),
    load: { avg1: loadStats.avg },
    swap: { avg: swapStats.avg, max: swapStats.max },
    network: {
      rx_rate_avg: stats(rows.map(r => r.net_rx_rate)).avg,
      tx_rate_avg: stats(rows.map(r => r.net_tx_rate)).avg
    },
    billing: {
      price: typeof agent.price === 'number' ? agent.price : 0,
      currency: agent.currency || '¥',
      billing_cycle: typeof agent.billing_cycle === 'number' ? agent.billing_cycle : 30,
      cycle_label: cycleLabel(typeof agent.billing_cycle === 'number' ? agent.billing_cycle : 30),
      auto_renewal: agent.auto_renewal ? true : false,
      expire_at: agent.expire_at || null,
      days_until_expire: daysUntil(agent.expire_at)
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
  const intervalSec = Number(process.env.AGENT_INTERVAL || DEFAULT_AGENT_INTERVAL);
  const offlineSec = Number(alertCfg.offline_sec || process.env.OFFLINE_THRESHOLD_SEC || 60);
  const cpuAlert = Number(alertCfg.cpu_pct || process.env.ALERT_CPU_PCT || 90);
  const memAlert = Number(alertCfg.mem_pct || process.env.ALERT_MEM_PCT || 90);

  const agents = db.getAgents();
  // 一次拉全量再分组，避免逐台查询（同 /agents/sparklines 模式，api.js:258）
  // 注意：62 台 × 30d 下 metrics 表超 330 万行，直接 getMetricsAll(SELECT *) 会把整表物化进内存触发 OOM。
  // 改用 SQL 层按 agent 时间桶降采样（每 agent 最多 AI_SAMPLE_POINTS 点，仅指标列不含 probes 大字段），
  // avg/p95/峰值统计对日报足够准确，内存下降 50x+。
  const AI_SAMPLE_POINTS = 1000;
  const rows = db.metricsSparklinesAllSampled(sinceTs, AI_SAMPLE_POINTS);
  const byAgent = {};
  for (const r of rows) {
    (byAgent[r.agent_id] || (byAgent[r.agent_id] = [])).push(r);
  }

  // 磁盘趋势：单独一条轻量序列（1 次查询覆盖 3d/7d/14d 全部窗口，按窗切片在 JS 里算）
  const trendDays = resolveTrendDays();
  const diskSeriesByAgent = {};
  if (trendDays > 0) {
    const trendRows = db.metricsDiskTrendAll(Date.now() - AI_TREND_FETCH_DAYS * 86400000, AI_TREND_BUCKET_MS);
    for (const r of trendRows) {
      (diskSeriesByAgent[r.agent_id] || (diskSeriesByAgent[r.agent_id] = [])).push({ ts: r.ts, pct: r.pct });
    }
  }

  const sumOpts = { intervalSec, offlineSec, cpuAlert, memAlert, diskSeriesByAgent, trendDays };
  const out = agents.map(a => summarizeAgent(a, byAgent[a.id] || [], sumOpts));
  const onlineCount = out.filter(s => s.online).length;

  return {
    generated_at: new Date().toISOString(),
    period: `${periodHours}h`,
    agent_count: agents.length,
    online_count: onlineCount,
    offline_count: agents.length - onlineCount,
    thresholds: { cpu_pct: cpuAlert, mem_pct: memAlert, offline_sec: offlineSec },
    disk_trend_days: trendDays,
    agents: out
  };
}

module.exports = { summarize, summarizeAgent, stats };
