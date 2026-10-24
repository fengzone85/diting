'use strict';
// S2 第一阶段：分钟级明细 → 小时级历史（metrics_hour）。
//
// 灰度约定（MONITOR_PARITY_PLAN S2.7）：
//   第一段（本文件）：只折叠、不删除明细、不改查询路由 —— 用于验证折叠值；
//   第二段：再开 prune 删除 + 查询合并读（metrics_hour + metrics UNION ALL 加权）。
// 这样折叠未验证前不会出现「同窗口两份口径不一致」。
//
// 核心设计（对齐 monitor db.rs:1779-1936）：
//   - 水位线 metrics_rolled 存 admin_config：只折叠「已封口」的整点小时；
//   - 每小时一个事务（折叠 + 推进水位线原子提交），提交后让出事件循环给 /report；
//   - 迟到容忍 LATE：整点后 1 小时零 1 分钟才认为该小时不再有新数据。

const db = require('./db');

const sqlite = db.db;
const HOUR = 3600 * 1000;
const LATE = HOUR + 60 * 1000;
const DEFAULT_DETAIL_DAYS = 7;

const ENABLED = process.env.METRICS_ROLLUP_ENABLED !== '0';

const hourStart = (ts) => Math.floor(Number(ts) / HOUR) * HOUR;
const round1 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)))
  ? null
  : Math.round(Number(v) * 10) / 10;

// METRICS_DETAIL_DAYS：明细保留天数（默认 7，钳 [3,30]）。
// 与 keepDays 取 min 由调用方处理（monitor db.rs:1906 同款夹取）。
function detailDays() {
  const raw = Number(process.env.METRICS_DETAIL_DAYS);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DETAIL_DAYS;
  return Math.min(30, Math.max(3, n));
}

const FOLD_HOUR_SQL = `
INSERT OR REPLACE INTO metrics_hour (
  agent_id, hour_ts, n,
  cpu_avg, cpu_max, mem_pct_avg, mem_pct_max, mem_used_avg, mem_total_avg,
  disk_pct_avg, disk_pct_max, disk_used_avg, disk_total_avg,
  load1_avg, load1_max, load5_avg, load15_avg,
  net_rx_rate_avg, net_rx_rate_max, net_tx_rate_avg, net_tx_rate_max,
  net_rx_month, net_tx_month,
  swap_pct_avg, swap_used_avg, swap_total_avg, uptime_avg, temp_avg, temp_max,
  disk_r_rate_max, disk_w_rate_max, process_count_max
)
SELECT a.agent_id, @hour, a.n,
  a.cpu_avg, a.cpu_max, a.mem_pct_avg, a.mem_pct_max, a.mem_used_avg, a.mem_total_avg,
  a.disk_pct_avg, a.disk_pct_max, a.disk_used_avg, a.disk_total_avg,
  a.load1_avg, a.load1_max, a.load5_avg, a.load15_avg,
  a.net_rx_rate_avg, a.net_rx_rate_max, a.net_tx_rate_avg, a.net_tx_rate_max,
  l.net_rx_month, l.net_tx_month,
  a.swap_pct_avg, a.swap_used_avg, a.swap_total_avg, a.uptime_avg, a.temp_avg, a.temp_max,
  a.disk_r_rate_max, a.disk_w_rate_max, a.process_count_max
FROM (
  SELECT agent_id, COUNT(*) AS n,
    AVG(cpu) AS cpu_avg, MAX(cpu) AS cpu_max,
    AVG(mem_pct) AS mem_pct_avg, MAX(mem_pct) AS mem_pct_max,
    AVG(mem_used) AS mem_used_avg, AVG(mem_total) AS mem_total_avg,
    AVG(disk_pct) AS disk_pct_avg, MAX(disk_pct) AS disk_pct_max,
    AVG(disk_used) AS disk_used_avg, AVG(disk_total) AS disk_total_avg,
    AVG(load1) AS load1_avg, MAX(load1) AS load1_max,
    AVG(load5) AS load5_avg, AVG(load15) AS load15_avg,
    AVG(net_rx_rate) AS net_rx_rate_avg, MAX(net_rx_rate) AS net_rx_rate_max,
    AVG(net_tx_rate) AS net_tx_rate_avg, MAX(net_tx_rate) AS net_tx_rate_max,
    AVG(swap_pct) AS swap_pct_avg, AVG(swap_used) AS swap_used_avg, AVG(swap_total) AS swap_total_avg,
    AVG(uptime) AS uptime_avg, AVG(temp) AS temp_avg, MAX(temp) AS temp_max,
    MAX(disk_r_rate) AS disk_r_rate_max, MAX(disk_w_rate) AS disk_w_rate_max,
    MAX(process_count) AS process_count_max
  FROM metrics
  WHERE ts >= @hour AND ts < @end AND agent_id IN (SELECT id FROM agents)
  GROUP BY agent_id
) a
JOIN (
  -- 计费曲线（月累计）取小时末行：AVG 会让曲线出现回退/抖动
  SELECT agent_id, net_rx_month, net_tx_month FROM (
    SELECT agent_id, net_rx_month, net_tx_month,
           ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ts DESC) AS rn
    FROM metrics
    WHERE ts >= @hour AND ts < @end AND agent_id IN (SELECT id FROM agents)
  ) WHERE rn = 1
) l ON l.agent_id = a.agent_id`;

const foldHourStmt = sqlite.prepare(FOLD_HOUR_SQL);
// '{}' 是 insertMetric 的缺省值（无探测的节点每行都有）——SQL 层先排掉，
// 避免每小时每节点都白解析一次 JSON。
const probesRowsStmt = sqlite.prepare(
  "SELECT agent_id, probes FROM metrics WHERE ts >= ? AND ts < ? AND probes IS NOT NULL AND probes NOT IN ('{}', '') AND agent_id IN (SELECT id FROM agents)"
);
const updateProbesStmt = sqlite.prepare('UPDATE metrics_hour SET probes_hour = ? WHERE agent_id = ? AND hour_ts = ?');

// 把一个小时内的探测结果按 label 折叠。
// 结构（S2 + F4 协调后）：
//   ms_avg/loss_avg  只对非空样本求均值（三态下超时样本 ms=null，不能拉低均值）
//   n                总样本数（诊断）
//   n_ms / n_loss    对应均值的分母
//   n_ok             成功样本数（可用率聚合的最小二乘：小时行也保留 ok 计数）
//   cert_min         期内最小剩余天数（证书倒计时在折叠层仍可追溯）
//   type             'http' 只要期内出现过 http 目标
function foldProbes(rows) {
  const byAgent = new Map();
  for (const row of rows) {
    let probes;
    try { probes = JSON.parse(row.probes); } catch (e) { continue; }
    if (!probes || typeof probes !== 'object' || Array.isArray(probes)) continue;
    let labels = byAgent.get(row.agent_id);
    if (!labels) { labels = new Map(); byAgent.set(row.agent_id, labels); }
    for (const [label, p] of Object.entries(probes)) {
      if (!p || typeof p !== 'object') continue;
      let acc = labels.get(label);
      if (!acc) {
        acc = { msSum: 0, nMs: 0, lossSum: 0, nLoss: 0, n: 0, nOk: 0, certMin: null, http: false };
        labels.set(label, acc);
      }
      acc.n++;
      if (typeof p.ms === 'number' && Number.isFinite(p.ms)) { acc.msSum += p.ms; acc.nMs++; }
      if (typeof p.loss === 'number' && Number.isFinite(p.loss)) { acc.lossSum += p.loss; acc.nLoss++; }
      if (p.ok !== false) acc.nOk++;
      if (typeof p.cert_days === 'number' && Number.isFinite(p.cert_days)) {
        acc.certMin = acc.certMin === null ? p.cert_days : Math.min(acc.certMin, p.cert_days);
      }
      if (p.type === 'http') acc.http = true;
    }
  }
  const out = new Map();
  for (const [agentId, labels] of byAgent) {
    const obj = {};
    for (const [label, a] of labels) {
      obj[label] = {
        ms_avg: a.nMs ? round1(a.msSum / a.nMs) : null,
        loss_avg: a.nLoss ? round1(a.lossSum / a.nLoss) : null,
        n: a.n,
        n_ms: a.nMs,
        n_loss: a.nLoss,
        n_ok: a.nOk,
        cert_min: a.certMin,
        type: a.http ? 'http' : 'tcp',
      };
    }
    // 老 agent/空对象（insertMetric 会写 '{}'）不产生 probes_hour，避免空 JSON 占位
    if (Object.keys(obj).length) out.set(agentId, obj);
  }
  return out;
}

// 折叠单个整点小时（折叠 + 写 probes + 推进水位线，同一事务）。
// 幂等：INSERT OR REPLACE + probes UPDATE，重折同一小时结果不变。
const foldHourTx = sqlite.transaction((hour) => {
  const end = hour + HOUR;
  const info = foldHourStmt.run({ hour, end });
  const rows = probesRowsStmt.all(hour, end);
  let agents = 0;
  if (rows.length) {
    const folded = foldProbes(rows);
    for (const [agentId, labels] of folded) {
      updateProbesStmt.run(JSON.stringify(labels), agentId, hour);
      agents++;
    }
  }
  db.setMetricsWatermark(end);
  return { rows: info.changes, agents };
});

function foldHour(hourTs) {
  return foldHourTx(hourStart(hourTs));
}

// 水位线初始化：没有就取 MIN(ts) 所在整点（有界回填起点）；无数据取当前整点。
function ensureWatermark(now) {
  let wm = db.getMetricsWatermark();
  if (wm) return wm;
  const row = sqlite.prepare('SELECT MIN(ts) AS m FROM metrics').get();
  wm = row && row.m ? hourStart(row.m) : hourStart(now);
  db.setMetricsWatermark(wm);
  return wm;
}

// 一次追赶：从水位线折到「已封口」的最新小时。
// maxHours 供测试/首次回填限流；每 24 小时让出一次事件循环。
async function runOnce(options = {}) {
  if (!ENABLED) return { folded: 0, disabled: true };
  const now = Number(options.now) || Date.now();
  const keepDays = db.getRetentionDays();
  const floor = hourStart(now - keepDays * 86400000);
  // 可折叠的最大小时起点：该小时已结束且超过迟到容忍
  const upper = hourStart(now - HOUR - LATE);

  let wm = ensureWatermark(now);
  if (wm < floor) {
    // 超出保留窗口的旧明细不再折叠（马上会被 prune 删除），水位线直接抬到 floor
    wm = floor;
    db.setMetricsWatermark(wm);
  }

  let folded = 0;
  const max = Number(options.maxHours) > 0 ? Number(options.maxHours) : Infinity;
  while (wm <= upper && folded < max) {
    foldHour(wm);
    wm += HOUR;
    folded++;
    if (folded % 24 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  if (folded) {
    console.log(`[rollup] folded ${folded} hour(s), watermark=${new Date(wm).toISOString()}`);
  }
  return { folded, watermark: wm };
}

let timer = null;
let alignTimer = null;

function start() {
  if (!ENABLED) {
    console.log('[rollup] disabled by METRICS_ROLLUP_ENABLED=0');
    return;
  }
  // 启动即追赶（含从旧备份恢复后「数据比水位线新」的场景）
  runOnce().catch((e) => console.error('[rollup] startup catch-up failed:', e.message));
  const delay = HOUR - (Date.now() % HOUR) + 5000;
  alignTimer = setTimeout(() => {
    runOnce().catch((e) => console.error('[rollup] hourly run failed:', e.message));
    timer = setInterval(() => {
      runOnce().catch((e) => console.error('[rollup] hourly run failed:', e.message));
    }, HOUR);
    timer.unref();
  }, delay);
  alignTimer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  if (alignTimer) clearTimeout(alignTimer);
  timer = null;
  alignTimer = null;
}

module.exports = {
  HOUR,
  LATE,
  ENABLED,
  hourStart,
  detailDays,
  foldProbes,
  foldHour,
  ensureWatermark,
  runOnce,
  start,
  stop,
};
