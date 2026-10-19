'use strict';
// P1 服务端流量口径累加器（纯函数，便于单测）。
// 口径：Komari month_rotate；0=绝对累计，1-31=周期重置日；legacy（无绝对计数器）透传上报月累计。

const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;

const clampCounter = (v) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_SAFE_COUNTER, Math.max(0, n));
};

const normalizeRotate = (v) => {
  if (v === null || v === undefined) return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 31) return null;
  return n;
};

const hasCounter = (report) =>
  !!report &&
  report.net_rx !== null && report.net_rx !== undefined &&
  report.net_tx !== null && report.net_tx !== undefined;

const daysInMonth = (year, monthIndex0) =>
  new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();

// Komari getActualResetDate 等价：本月有 rotate 日则取本月该日 00:00；否则顺延到下月 1 日 00:00。
function actualResetMs(year, monthIndex0, rotate, tzOffsetHours) {
  const dim = daysInMonth(year, monthIndex0);
  let y = year;
  let m = monthIndex0;
  let d = rotate;
  if (rotate > dim) {
    const next = new Date(Date.UTC(year, monthIndex0 + 1, 1));
    y = next.getUTCFullYear();
    m = next.getUTCMonth();
    d = 1;
  }
  return Date.UTC(y, m, d) - tzOffsetHours * 3600000;
}

// 返回 <= now 的最近一次重置时刻（epoch ms）。tzOffsetHours 仅用于把“自然日边界”固定到服务端口径时区。
function lastResetDate(rotateInput, nowMs, tzOffsetHours = 0) {
  const rotate = normalizeRotate(rotateInput) || 0;
  if (!rotate) return null;
  const tz = Number(tzOffsetHours) || 0;
  const local = new Date(nowMs + tz * 3600000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  let reset = actualResetMs(y, m, rotate, tz);
  if (nowMs < reset) {
    // Date.UTC(y, m, 0) 是上月最后一天；跨年时 getUTCFullYear/Month 已正确回退。
    const prev = new Date(Date.UTC(y, m, 0));
    reset = actualResetMs(prev.getUTCFullYear(), prev.getUTCMonth(), rotate, tz);
  }
  return reset;
}

const cycleKeyOf = (resetMs, tzOffsetHours = 0) => {
  if (resetMs === null || resetMs === undefined) return 'cumulative';
  const tz = Number(tzOffsetHours) || 0;
  return new Date(resetMs + tz * 3600000).toISOString().slice(0, 10);
};

const emptyState = (agentId) => ({
  agent_id: agentId,
  cycle_key: null,
  cycle_start: null,
  used_rx: 0,
  used_tx: 0,
  last_rx: null,
  last_tx: null,
  last_ts: 0,
  updated_at: 0,
});

// 输入 state 会被原地更新；report 为 validateReport 之后的对象（net_rx/net_tx/month_rotate 可空）。
// 返回 { has_counter, used_rx, used_tx }；调用方负责把 used_* 回写到 metrics.net_*_month。
function accumulate(state, agent, report, nowMs, tzOffsetHours = 0) {
  const out = { has_counter: hasCounter(report), used_rx: 0, used_tx: 0 };
  if (!out.has_counter) {
    state.used_rx = clampCounter(report.net_rx_month ?? 0);
    state.used_tx = clampCounter(report.net_tx_month ?? 0);
    state.updated_at = nowMs;
    out.used_rx = state.used_rx;
    out.used_tx = state.used_tx;
    return out;
  }

  const baseRx = clampCounter(report.net_rx);
  const baseTx = clampCounter(report.net_tx);
  const agentRotate = agent && agent.month_rotate !== undefined ? normalizeRotate(agent.month_rotate) : null;
  const rotate = agentRotate !== null ? agentRotate : (normalizeRotate(report.month_rotate) ?? 0);

  const cycleStart = rotate === 0 ? null : lastResetDate(rotate, nowMs, tzOffsetHours);
  const cycleKey = rotate === 0 ? 'cumulative' : cycleKeyOf(cycleStart, tzOffsetHours);
  const newCycle = state.cycle_key !== cycleKey;
  if (newCycle) {
    state.cycle_key = cycleKey;
    state.cycle_start = cycleStart;
    state.used_rx = 0;
    state.used_tx = 0;
  }

  if (rotate === 0) {
    state.used_rx = baseRx;
    state.used_tx = baseTx;
  } else if (!newCycle && state.last_rx !== null && state.last_rx !== undefined) {
    // 新周期首报只设基线，不把上一周期尾巴计入新周期。
    state.used_rx = clampCounter(state.used_rx + Math.max(baseRx - state.last_rx, 0));
    state.used_tx = clampCounter(state.used_tx + Math.max(baseTx - state.last_tx, 0));
  }

  state.last_rx = baseRx;
  state.last_tx = baseTx;
  state.last_ts = nowMs;
  state.updated_at = nowMs;
  out.used_rx = state.used_rx;
  out.used_tx = state.used_tx;
  return out;
}

module.exports = {
  MAX_SAFE_COUNTER,
  clampCounter,
  normalizeRotate,
  hasCounter,
  lastResetDate,
  cycleKeyOf,
  emptyState,
  accumulate,
};
