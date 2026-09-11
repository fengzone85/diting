// stats.js —— 纯统计/数学工具（**零 DB 依赖**）
//
// 从 summarizer.js 抽出，便于单测（不需要打开数据库）。
// diskTrend 是磁盘趋势的定稿实现：
//   - 斜率：对给定窗口「等分 6 段」取段末值差分，再取中位数（抗单点尖峰 + 平滑日锯齿）
//   - 分子：固定「近 24h 桶中位」（不能用末点：实测末点 73.10% vs 近 24h 中位 75.26%，差 4pp；
//           尖峰注入时末点分子会让估计变化 −30%）
//   - 区间：跨窗口取「最快/最慢」，p25 ≤ 0（存在回落）时上界不设值
// 实测依据见 dev-docs/AI_HARDENING_AUDIT_2026-09-10.md「第三轮」。

'use strict';

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
// intervalSec 由调用方传入（默认值与 agent 的 INTERVAL 保持一致）。
function overThresholdMinutes(arr, threshold, intervalSec) {
  const a = nums(arr);
  let cnt = 0;
  for (const v of a) if (v >= threshold) cnt++;
  return Math.round(cnt * (intervalSec / 60));
}

function median(a) {
  const s = nums(a).sort((x, y) => x - y);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function quantile(a, q) {
  const s = nums(a).sort((x, y) => x - y);
  if (!s.length) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
}

// 旧算法：24h 首末两点线性外推（仅作为 AI_TREND_DAYS=0 或趋势数据不足时的回退）。
// 返回 null 表示数据不足或当前已 ≥90%（无可推算空间）。
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
  if (last.p >= 90) return null;     // 已达阈值
  const pctPerDay = dp / dtDays;
  return Math.round((90 - last.p) / pctPerDay);
}

// 内存斜率：首末差值（百分点），正=上升（疑似增长），用于 AI 判断泄漏趋势。
function memSlope(rows) {
  const pts = nums(rows.map(r => r.mem_pct));
  if (pts.length < 2) return null;
  return +(pts[pts.length - 1] - pts[0]).toFixed(2);
}

// 磁盘趋势估计。
//   series: [{ts, pct}] 升序（来自 DB 的桶聚合，1h 桶；必须是真实 ts，不能用桶号）
//   opts:   { maxDays = 7, windows = [3, 7, 14], seg = 6 }
// 返回： { note, level?, days_to_90?, range?, slope_pct_per_day?, confidence?, window_days?, span_days? }
//   note: 'ok' | 'insufficient'（跨度 <2 天）| 'no_growth'（斜率 ≤0）| 'reached'（已 ≥90%）
function diskTrend(series, opts) {
  const o = opts || {};
  const maxDays = Number.isFinite(o.maxDays) && o.maxDays > 0 ? o.maxDays : 7;
  const windows = Array.isArray(o.windows) && o.windows.length ? o.windows : [3, 7, 14];
  const seg = Math.max(3, Math.round(Number(o.seg) || 6));

  const pts = (series || []).filter((r) => r && Number.isFinite(r.ts) && Number.isFinite(r.pct));
  if (pts.length < seg + 1) return { note: 'insufficient' };

  const endTs = pts[pts.length - 1].ts;
  const spanDays = (endTs - pts[0].ts) / 86400000;
  // 主窗口 = min(实际跨度, maxDays)。跨度 <2 天直接放弃：1 天窗口的段长仅数小时，
  // 落在磁盘「日锯齿」周期内，实测会输出 61.6 天这类纯噪声数字（真实 7~20 天）。
  const mainDays = Math.min(spanDays, maxDays);
  if (mainDays < 2) return { note: 'insufficient', span_days: +spanDays.toFixed(2) };

  // 分子：固定「近 24h 桶中位」，与展示同源（不足 3 个桶则退回全序列中位）
  const recent = pts.filter((r) => r.ts > endTs - 86400000);
  const level = recent.length >= 3 ? median(recent.map((r) => r.pct)) : median(pts.map((r) => r.pct));
  if (!(level < 90)) return { note: 'reached', level: +level.toFixed(2), span_days: +mainDays.toFixed(2) };

  // 单个窗口的斜率族：等分 seg 段 → 段末值差分 / 段长 = pp/天
  const calc = (days) => {
    const from = endTs - days * 86400000;
    const sp = pts.filter((r) => r.ts >= from);
    if (sp.length < seg + 1) return null;
    const t0 = sp[0].ts;
    const w = (sp[sp.length - 1].ts - t0) / seg;
    if (!(w > 0)) return null;
    const ends = [];
    for (let i = 0; i < seg; i++) {
      const idx = i;
      const inSeg = sp.filter((r) => Math.min(seg - 1, Math.floor((r.ts - t0) / w)) === idx);
      if (inSeg.length) ends.push(inSeg[inSeg.length - 1].pct);
    }
    if (ends.length < 3) return null;
    const slopes = [];
    for (let i = 1; i < ends.length; i++) slopes.push((ends[i] - ends[i - 1]) / (w / 86400000));
    return { m: median(slopes), p25: quantile(slopes, 0.25), p75: quantile(slopes, 0.75), days };
  };

  const main = calc(mainDays);
  if (!main || !(main.m > 0)) {
    return { note: 'no_growth', level: +level.toFixed(2), span_days: +mainDays.toFixed(2) };
  }

  const toDays = (slope) => (slope > 0 ? (90 - level) / slope : null);

  // 区间：跨窗口取最快（p75 斜率→天数最小）与最慢（p25 斜率→天数最大）；
  // 任一窗口 p25 ≤ 0（存在回落/不增长）→ 上界不设值，报告写「可能更久」。
  const perWin = [];
  for (const d of windows) {
    const c = calc(Math.min(spanDays, d));
    if (c) perWin.push(c);
  }
  const pool = perWin.length ? perWin : [main];
  const hasDrop = pool.some((c) => !(c.p25 > 0));
  const fast = toDays(Math.max(...pool.map((c) => c.p75)));
  const slow = hasDrop ? null : toDays(Math.min(...pool.map((c) => c.p25)));
  const allUp = pool.every((c) => c.m > 0);
  const range = fast == null ? null : [Math.min(fast, slow == null ? fast : slow), slow == null ? null : Math.max(fast, slow)];

  return {
    note: 'ok',
    level: +level.toFixed(2),
    days_to_90: toDays(main.m),
    range,
    slope_pct_per_day: main.m,
    confidence: (allUp && !hasDrop && spanDays >= 7) ? 'medium' : 'low',
    window_days: +mainDays.toFixed(2),
    span_days: +spanDays.toFixed(2),
    has_drop: hasDrop
  };
}

// ---- 风险分级（确定性锚点）----
// 模型对「整体风险等级」的自由裁量很容易被少数扎眼节点带偏（实测某站点曾连续多日恒为 high）。
// 这里先用本地规则算一个确定性的 baseline，模型只能在此基础上上下浮动一级（见 report.clampRisk）。

// 是否属于「指标超阈值节点」：超阈值分钟数 > 0，或峰值达到告警阈值。
function isOverThreshold(a, cpuAlert, memAlert) {
  const c = a.cpu || {};
  const m = a.memory || {};
  if ((c.over_threshold_minutes || 0) > 0 || (m.over_threshold_minutes || 0) > 0) return true;
  if (c.max != null && c.max >= cpuAlert) return true;
  if (m.max != null && m.max >= memAlert) return true;
  return false;
}

// 汇总用于分级与展示的信号量。
function computeSignals(summaryAgents, opts) {
  const o = opts || {};
  const cpuAlert = Number(o.cpuAlert) || 90;
  const memAlert = Number(o.memAlert) || 90;
  const list = Array.isArray(summaryAgents) ? summaryAgents : [];
  const agents = list.length;
  const offline = list.filter((a) => !a.online).length;
  const stale = list.filter((a) => a.stale).length;
  const overThreshold = list.filter((a) => isOverThreshold(a, cpuAlert, memAlert)).length;
  const expiring7d = list.filter((a) => a.billing && a.billing.days_until_expire != null && a.billing.days_until_expire <= 7).length;
  return {
    agents,
    online: agents - offline,
    offline,
    stale,
    offline_ratio: agents ? +(offline / agents).toFixed(3) : 0,
    over_threshold: overThreshold,
    expiring_7d: expiring7d
  };
}

// 本地规则分级：离线占比 >30% 且离线数 ≥3，或超阈值节点 ≥3 → high；
// 有离线 / 有超阈值 / 有 7 天内临期 → medium；否则 low。
// 「至少 3 台」的门槛是为了小规模部署：2 台里掉 1 台占比就有 50%，不该直接判 high。
function baselineRisk(signals) {
  const s = signals || {};
  if (((s.offline_ratio || 0) > 0.3 && (s.offline || 0) >= 3) || (s.over_threshold || 0) >= 3) return 'high';
  if ((s.offline || 0) > 0 || (s.over_threshold || 0) >= 1 || (s.expiring_7d || 0) >= 1) return 'medium';
  return 'low';
}

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

// 把模型给出的 risk_level 锚定到 baseline 的 ±1 级；非法值原样返回（渲染层会兜底）。
function clampRisk(raw, baseline) {
  const ri = RISK_ORDER[String(raw || '').toLowerCase()];
  const bi = RISK_ORDER[baseline];
  if (ri == null || bi == null) return raw;
  const capped = Math.max(bi - 1, Math.min(bi + 1, ri));
  return Object.keys(RISK_ORDER).find((k) => RISK_ORDER[k] === capped);
}

module.exports = {
  nums, stats, overThresholdMinutes, median, quantile, diskFullDays, diskTrend, memSlope,
  computeSignals, baselineRisk, clampRisk
};
