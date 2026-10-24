'use strict';
// ============================================================
// S2 第二段：小时行 + 明细行「加权合并读」。
//
// 分叉条件是**水位线**而不是固定 7 天：wm 之前的小时行已封口，wm 之后的明细还在写。
// 这样即便 rollup 暂时落后，也不会出现「既不在小时表、又被 prune 删掉」的盲区。
// 与 monitor 的有意偏差：monitor 明细侧固定夹 DETAIL_DAYS，我们按 wm 分叉。
//
// 权重：小时行 n（该小时明细行数），明细行 1；均值加权、峰值/末值取 MAX。
// 时间桶宽度由窗口/maxPoints 反推，输出行数 ≈ maxPoints（不再用窗口函数抽样）。
//
// 首末点精度：桶输出是加权平均，磁盘耗尽预测依赖 disk_used 的**精确**首末值。
// 因此合并查询返回后，若首沿落在明细段（since >= effDetailStart），用明细行覆盖
// 首点；末点一律用 until 前最后一条明细覆盖（取不到才保留小时推导值）。
// ============================================================

const HOUR = 3600 * 1000;

// 明细保留天数（与 rollup.js 同一环境变量，避免互相 require 造成环）
function detailDays() {
  const raw = Number(process.env.METRICS_DETAIL_DAYS);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7;
  return Math.min(30, Math.max(3, n));
}

// 水位线（0 = 尚未折叠 / 折叠关闭）
function watermark(db) {
  try {
    const r = db.prepare("SELECT value FROM admin_config WHERE key='metrics_rolled'").get();
    const v = Number(r && r.value);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  } catch (e) {
    return 0;
  }
}

// 长窗口首点的精度上限就是小时均值：only if since >= effDetailStart 才允许用明细覆盖首点
function effectiveDetailStart(db, now) {
  const wm = watermark(db);
  const cut = now - detailDays() * 86400000;
  return wm > 0 ? Math.min(cut, wm) : cut;
}

const avg = (out, hour, detail) => ({ out, hour, detail, mode: 'avg' });
const max = (out, hour, detail) => ({ out, hour, detail, mode: 'max' });
const nul = (out) => ({ out, hour: 'NULL', detail: 'NULL', mode: 'max' });

// 负载曲线列集（与 heavy-queries.js LOAD_COLS 一致）
const LOAD_SPEC = [
  avg('cpu', 'cpu_avg', 'cpu'),
  avg('mem_used', 'mem_used_avg', 'mem_used'),
  avg('mem_total', 'mem_total_avg', 'mem_total'),
  avg('mem_pct', 'mem_pct_avg', 'mem_pct'),
  avg('load1', 'load1_avg', 'load1'),
  avg('load5', 'load5_avg', 'load5'),
  avg('load15', 'load15_avg', 'load15'),
  avg('net_rx_rate', 'net_rx_rate_avg', 'net_rx_rate'),
  avg('net_tx_rate', 'net_tx_rate_avg', 'net_tx_rate'),
  max('net_rx_month', 'net_rx_month', 'net_rx_month'),
  max('net_tx_month', 'net_tx_month', 'net_tx_month'),
  avg('disk_used', 'disk_used_avg', 'disk_used'),
  avg('disk_total', 'disk_total_avg', 'disk_total'),
  max('disk_r_rate', 'disk_r_rate_max', 'disk_r_rate'),
  max('disk_w_rate', 'disk_w_rate_max', 'disk_w_rate'),
  avg('swap_used', 'swap_used_avg', 'swap_used'),
  avg('swap_total', 'swap_total_avg', 'swap_total'),
  avg('swap_pct', 'swap_pct_avg', 'swap_pct'),
  avg('temp', 'temp_avg', 'temp'),
  max('process_count', 'process_count_max', 'process_count'),
];

// sparklines 轻量列集（与 metricsSparklinesOne/AllSampled 一致）
const SPARK_SPEC = [
  avg('cpu', 'cpu_avg', 'cpu'),
  avg('mem_pct', 'mem_pct_avg', 'mem_pct'),
  avg('disk_pct', 'disk_pct_avg', 'disk_pct'),
  avg('net_rx_rate', 'net_rx_rate_avg', 'net_rx_rate'),
  avg('net_tx_rate', 'net_tx_rate_avg', 'net_tx_rate'),
  max('net_rx_month', 'net_rx_month', 'net_rx_month'),
  max('net_tx_month', 'net_tx_month', 'net_tx_month'),
  avg('load1', 'load1_avg', 'load1'),
  avg('temp', 'temp_avg', 'temp'),
  avg('swap_pct', 'swap_pct_avg', 'swap_pct'),
  avg('uptime', 'uptime_avg', 'uptime'),
  avg('disk_r_rate', 'disk_r_rate_max', 'disk_r_rate'),
  avg('disk_w_rate', 'disk_w_rate_max', 'disk_w_rate'),
  avg('disk_used', 'disk_used_avg', 'disk_used'),
  avg('disk_total', 'disk_total_avg', 'disk_total'),
  max('process_count', 'process_count_max', 'process_count'),
];

// /api/agents/:id/metrics 的全字段列集（probes/disks/id 无法按桶平均，统一给 NULL）
const RANGE_SPEC = [
  nul('id'),
  avg('cpu', 'cpu_avg', 'cpu'),
  avg('mem_used', 'mem_used_avg', 'mem_used'),
  avg('mem_total', 'mem_total_avg', 'mem_total'),
  avg('mem_pct', 'mem_pct_avg', 'mem_pct'),
  avg('disk_used', 'disk_used_avg', 'disk_used'),
  avg('disk_total', 'disk_total_avg', 'disk_total'),
  avg('disk_pct', 'disk_pct_avg', 'disk_pct'),
  avg('load1', 'load1_avg', 'load1'),
  avg('load5', 'load5_avg', 'load5'),
  avg('load15', 'load15_avg', 'load15'),
  avg('net_rx_rate', 'net_rx_rate_avg', 'net_rx_rate'),
  avg('net_tx_rate', 'net_tx_rate_avg', 'net_tx_rate'),
  max('net_rx_month', 'net_rx_month', 'net_rx_month'),
  max('net_tx_month', 'net_tx_month', 'net_tx_month'),
  avg('uptime', 'uptime_avg', 'uptime'),
  avg('temp', 'temp_avg', 'temp'),
  avg('swap_used', 'swap_used_avg', 'swap_used'),
  avg('swap_total', 'swap_total_avg', 'swap_total'),
  avg('swap_pct', 'swap_pct_avg', 'swap_pct'),
  avg('disk_r_rate', 'disk_r_rate_max', 'disk_r_rate'),
  avg('disk_w_rate', 'disk_w_rate_max', 'disk_w_rate'),
  nul('probes'),
  nul('disks'),
  max('process_count', 'process_count_max', 'process_count'),
  max('interval', 'NULL', 'interval'),
];

function outerExpr(s) {
  if (s.mode === 'max') return `MAX(${s.out}) AS ${s.out}`;
  return `SUM(${s.out} * w) / NULLIF(SUM(CASE WHEN ${s.out} IS NOT NULL THEN w END), 0) AS ${s.out}`;
}

// 加权合并查询：单节点（agentId）或跨节点（groupAgent）。
// until 上界必须一直带：AI 前一周期对比依赖它，缺了 prev 窗口会一路取到 now。
function weightedRows(db, spec, opts) {
  const { agentId, since, until, bucket, groupAgent } = opts;
  const wm = watermark(db);
  const hourCols = spec.map((s) => `${s.hour} AS ${s.out}`).join(',\n         ');
  const detailCols = spec.map((s) => `${s.detail} AS ${s.out}`).join(',\n         ');
  const outer = spec.map(outerExpr).join(',\n       ');
  const agentSel = groupAgent ? 'agent_id, ' : '';
  // 单节点查询也回填 agent_id：旧 SELECT * 含该列，保持响应 shape 不变
  const agentOut = groupAgent ? 'agent_id, ' : (agentId ? '@id AS agent_id, ' : '');
  const agentGroup = groupAgent ? 'agent_id, b' : 'b';
  const orderBy = groupAgent ? 'agent_id, b' : 'b';
  const agentFilterHour = agentId ? 'AND agent_id=@id' : '';
  const agentFilterDetail = agentId ? 'AND agent_id=@id' : '';
  const sql = `
    WITH src AS (
      SELECT ${agentSel}CAST((hour_ts - @since) / CAST(@bucket AS INTEGER) AS INTEGER) AS b, n AS w,
             ${hourCols}
      FROM metrics_hour
      WHERE hour_ts >= @since AND hour_ts < @wm AND (@until IS NULL OR hour_ts < @until) ${agentFilterHour}
      UNION ALL
      SELECT ${agentSel}CAST((ts - @since) / CAST(@bucket AS INTEGER) AS INTEGER) AS b, 1 AS w,
             ${detailCols}
      FROM metrics
      WHERE ts >= @since AND (@until IS NULL OR ts < @until) ${agentFilterDetail}
      AND (ts >= @wm OR NOT EXISTS (
             SELECT 1 FROM metrics_hour mh
             WHERE mh.agent_id = metrics.agent_id
               AND mh.hour_ts = CAST(ts / 3600000 AS INTEGER) * 3600000))
    )
    SELECT ${agentOut}(@since + CAST(b AS INTEGER) * @bucket) AS ts,
       ${outer}
    FROM src
    GROUP BY ${agentGroup}
    ORDER BY ${orderBy}`;
  return db.prepare(sql).all({
    since,
    until: until == null ? null : Number(until),
    bucket: Math.max(1, Math.floor(bucket)),
    wm,
    id: agentId,
  });
}

// 明细首/末行（用于覆盖桶输出的首末点）
function detailEdge(db, spec, { agentId, since, until, direction }) {
  const cols = spec.map((s) => `${s.detail} AS ${s.out}`).join(', ');
  const row = db.prepare(`
    SELECT ts, agent_id, ${cols} FROM metrics
    WHERE agent_id=@id AND ts >= @since AND (@until IS NULL OR ts < @until)
      AND (ts >= @wm OR NOT EXISTS (
        SELECT 1 FROM metrics_hour mh WHERE mh.agent_id = metrics.agent_id
          AND mh.hour_ts = CAST(ts / 3600000 AS INTEGER) * 3600000))
    ORDER BY ts ${direction === 'first' ? 'ASC' : 'DESC'} LIMIT 1`)
    .get({ id: agentId, since, until: until == null ? null : Number(until), wm: watermark(db) });
  return row || null;
}

function replaceEdge(rows, edge, which) {
  if (!edge) return rows;
  if (!rows.length) return [edge];
  // 去掉同桶的桶值，再放入明细行；保证 ts 单调
  const idx = which === 'first' ? 0 : rows.length - 1;
  const out = rows.slice();
  out[idx] = edge;
  out.sort((a, b) => a.ts - b.ts);
  // 同一个 ts 去重（保留明细行）
  return out.filter((r, i) => i === 0 || r.ts !== out[i - 1].ts || r === edge);
}

// 单节点首末点覆盖：首沿在明细段才覆盖（否则保留小时均值，属固有精度损失）。
function applyEdges(rows, db, spec, opts) {
  const { agentId, since, until, bucket } = opts;
  let out = rows;
  const last = detailEdge(db, spec, { agentId, since, until: until == null ? null : Number(until), direction: 'last' });
  out = replaceEdge(out, last, 'last');
  // 首点只在「明细首行落在首桶内」时覆盖：否则行来自窗口中部（其前的小时已折叠），
  // 直接覆盖会把中部数值挪到序列头，污染图表与磁盘耗尽外推。
  const first = detailEdge(db, spec, { agentId, since, until: until == null ? null : Number(until), direction: 'first' });
  if (first && first.ts < since + bucket) out = replaceEdge(out, first, 'first');
  return out;
}

// 跨节点首末点覆盖：每 agent 各覆盖首/末。
function applyEdgesAll(rows, db, spec, opts) {
  const { since, until, bucket } = opts;
  const agents = rows.length
    ? [...new Set(rows.map((r) => r.agent_id))]
    : db.prepare('SELECT DISTINCT agent_id FROM metrics WHERE ts >= ?').all(since).map((r) => r.agent_id);
  if (!agents.length) return rows;
  const byAgent = new Map();
  for (const r of rows) {
    if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
    byAgent.get(r.agent_id).push(r);
  }
  for (const id of agents) {
    let list = byAgent.get(id) || [];
    list = replaceEdge(list, detailEdge(db, spec, { agentId: id, since, until: until == null ? null : Number(until), direction: 'last' }), 'last');
    const first = detailEdge(db, spec, { agentId: id, since, until: until == null ? null : Number(until), direction: 'first' });
    if (first && first.ts < since + bucket) list = replaceEdge(list, first, 'first');
    byAgent.set(id, list);
  }
  return [...byAgent.values()].flat().sort((a, b) => (a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : a.ts - b.ts));
}

function spanBucket(since, until, maxPoints) {
  const end = until == null ? Date.now() : Number(until);
  const span = Math.max(HOUR, end - since);
  const points = Math.max(1, Math.floor(Number(maxPoints) || 1));
  return Math.max(1, Math.floor(span / points));
}

// ---- 对外形态 --------------------------------------------------------------

const loadOne = (db, agentId, since, maxPoints, until) => {
  const bucket = spanBucket(since, until, maxPoints);
  const rows = weightedRows(db, LOAD_SPEC, { agentId, since, until, bucket, groupAgent: false });
  return applyEdges(rows, db, LOAD_SPEC, { agentId, since, until, bucket });
};

const loadAll = (db, since, maxPoints, until) => {
  const bucket = spanBucket(since, until, maxPoints);
  const rows = weightedRows(db, LOAD_SPEC, { since, until, bucket, groupAgent: true });
  return applyEdgesAll(rows, db, LOAD_SPEC, { since, until, bucket });
};

const sparklinesOne = (db, agentId, since, maxPoints, until) => {
  const bucket = spanBucket(since, until, maxPoints);
  const rows = weightedRows(db, SPARK_SPEC, { agentId, since, until, bucket, groupAgent: false });
  return applyEdges(rows, db, SPARK_SPEC, { agentId, since, until, bucket });
};

const sparklinesAll = (db, since, maxPoints, until) => {
  const bucket = spanBucket(since, until, maxPoints);
  const rows = weightedRows(db, SPARK_SPEC, { since, until, bucket, groupAgent: true });
  return applyEdgesAll(rows, db, SPARK_SPEC, { since, until, bucket });
};

const rangeSampled = (db, agentId, since, maxPoints) => {
  const bucket = spanBucket(since, null, maxPoints);
  return weightedRows(db, RANGE_SPEC, { agentId, since, until: null, bucket, groupAgent: false });
};

// 集群平均：不分 agent，按桶加权
const clusterAvg = (db, since, spanMs, maxPoints) => {
  const bucket = Math.max(1, Math.ceil(Math.max(1, spanMs) / Math.max(1, maxPoints)));
  const rows = weightedRows(db, [avg('cpu', 'cpu_avg', 'cpu'), avg('mem_pct', 'mem_pct_avg', 'mem_pct')], {
    since, until: null, bucket, groupAgent: false,
  });
  return rows;
};

// 磁盘趋势：按 agent + 桶加权，输出 ts 为桶起点
const diskTrendAll = (db, since, bucketMs) => {
  const bucket = Math.max(1, bucketMs);
  return weightedRows(db, [avg('disk_pct', 'disk_pct_avg', 'disk_pct')], {
    since, until: null, bucket, groupAgent: true,
  });
};

// 月流量交叉校验：按小时桶加权平均速率，调用方再积分
const trafficEstimate = (db, agentId, since) => {
  const bucket = HOUR;
  const rows = weightedRows(db, [avg('rx', 'net_rx_rate_avg', 'net_rx_rate'), avg('tx', 'net_tx_rate_avg', 'net_tx_rate')], {
    agentId, since, until: null, bucket, groupAgent: false,
  });
  return rows.map((r) => ({ bucket: Math.floor(r.ts / HOUR), rx: r.rx, tx: r.tx }));
};

// ---- probes 合并 -----------------------------------------------------------
// 小时行的 probes_hour 结构 {ms_avg,loss_avg,n,n_ms,n_loss,n_ok,cert_min,type}
// 与明细 probes 的 {ms,ok,loss,type,code,cert_days} 都折算成同一累加器：
//   ms 以 n_ms 加权、loss 以 n_loss 加权、ok 用 n_ok 计数，cert 取最小。
function probeAccumulator() {
  return { ts: 0, msSum: 0, nMs: 0, lossSum: 0, nLoss: 0, n: 0, nOk: 0, nDown: 0, certMin: null, http: false, code: null };
}

function pushDetailProbe(acc, p, ts) {
  if (!p || typeof p !== 'object') return;
  acc.n++;
  if (typeof p.ms === 'number' && Number.isFinite(p.ms)) { acc.msSum += p.ms; acc.nMs++; }
  if (typeof p.loss === 'number' && Number.isFinite(p.loss)) { acc.lossSum += p.loss; acc.nLoss++; }
  // 三态：ok=null 既不计成功也不计失败
  if (p.ok === true) acc.nOk++;
  else if (p.ok === false) acc.nDown++;
  if (typeof p.cert_days === 'number' && Number.isFinite(p.cert_days)) {
    acc.certMin = acc.certMin === null ? p.cert_days : Math.min(acc.certMin, p.cert_days);
  }
  if (p.type === 'http') acc.http = true;
  if (Number.isInteger(p.code)) acc.code = p.code;
  acc.ts = Math.max(acc.ts || 0, ts || 0);
}

function pushHourProbe(acc, p, ts) {
  if (!p || typeof p !== 'object') return;
  const n = Math.max(1, Number(p.n) || 1);
  acc.n += n;
  const nMs = Number(p.n_ms) || 0;
  if (nMs > 0 && typeof p.ms_avg === 'number') { acc.msSum += p.ms_avg * nMs; acc.nMs += nMs; }
  const nLoss = Number(p.n_loss) || 0;
  if (nLoss > 0 && typeof p.loss_avg === 'number') { acc.lossSum += p.loss_avg * nLoss; acc.nLoss += nLoss; }
  acc.nOk += Number(p.n_ok) || 0;
  // n_samp 缺失 = 本列是 S3 之前折叠的（当时 ok 恒为布尔），按全部有采样处理
  const nSamp = Number.isFinite(Number(p.n_samp)) ? Number(p.n_samp) : n;
  acc.nDown += Math.max(0, nSamp - (Number(p.n_ok) || 0));
  if (typeof p.cert_min === 'number' && Number.isFinite(p.cert_min)) {
    acc.certMin = acc.certMin === null ? p.cert_min : Math.min(acc.certMin, p.cert_min);
  }
  if (p.type === 'http') acc.http = true;
  acc.ts = Math.max(acc.ts || 0, ts || 0);
}

function finishProbe(acc) {
  // 三态：没有任何 ok 布尔样本 → ok=null（无采样），loss 也保持 null
  const sampled = acc.nOk + acc.nDown;
  const out = {
    ms: acc.nMs ? Math.round((acc.msSum / acc.nMs) * 10) / 10 : null,
    ok: sampled === 0 ? null : acc.nOk > 0,
    loss: acc.nLoss ? Math.round(acc.lossSum / acc.nLoss) : (sampled === 0 ? null : (acc.nOk > 0 ? 0 : 100)),
  };
  if (acc.http) out.type = 'http';
  if (acc.code !== null) out.code = acc.code;
  if (acc.certMin !== null) out.cert_days = acc.certMin;
  return out;
}

// 把一行的 probes JSON 折算进 [agent][bucket][label] 累加器
function foldProbeRow(store, agentId, bucket, ts, probesJson, folded) {
  let probes;
  try { probes = JSON.parse(probesJson); } catch (e) { return; }
  if (!probes || typeof probes !== 'object' || Array.isArray(probes)) return;
  let byBucket = store.get(agentId);
  if (!byBucket) { byBucket = new Map(); store.set(agentId, byBucket); }
  let byLabel = byBucket.get(bucket);
  if (!byLabel) { byLabel = new Map(); byBucket.set(bucket, byLabel); }
  for (const [label, p] of Object.entries(probes)) {
    let acc = byLabel.get(label);
    if (!acc) { acc = probeAccumulator(); byLabel.set(label, acc); }
    if (folded) pushHourProbe(acc, p, ts); else pushDetailProbe(acc, p, ts);
  }
}

function probeRows(db, { agentId, since, until, bucket, groupAgent }) {
  const wm = watermark(db);
  const store = new Map();
  const hourAgent = agentId ? 'AND agent_id=@id' : '';
  const detailAgent = agentId ? 'AND agent_id=@id' : '';
  const hourRows = db.prepare(`
    SELECT agent_id, hour_ts AS ts, probes_hour AS probes
    FROM metrics_hour
    WHERE hour_ts >= @since AND hour_ts < @wm AND (@until IS NULL OR hour_ts < @until)
      AND probes_hour IS NOT NULL ${hourAgent}`).all({
    id: agentId, since, wm, until: until == null ? null : Number(until),
  });
  for (const r of hourRows) {
    const b = Math.floor((r.ts - since) / bucket);
    foldProbeRow(store, r.agent_id, b, r.ts, r.probes, true);
  }
  const detailRows = db.prepare(`
    SELECT agent_id, ts, probes FROM metrics
    WHERE ts >= @since AND (@until IS NULL OR ts < @until)
      AND probes IS NOT NULL AND probes NOT IN ('{}', '') ${detailAgent}
      AND (ts >= @wm OR NOT EXISTS (
        SELECT 1 FROM metrics_hour mh WHERE mh.agent_id = metrics.agent_id
          AND mh.hour_ts = CAST(ts / 3600000 AS INTEGER) * 3600000))`).all({
    id: agentId, since, wm, until: until == null ? null : Number(until),
  });
  for (const r of detailRows) {
    const b = Math.floor((r.ts - since) / bucket);
    foldProbeRow(store, r.agent_id, b, r.ts, r.probes, false);
  }

  const rows = [];
  for (const [aid, byBucket] of store) {
    const buckets = [...byBucket.keys()].sort((a, b) => a - b);
    for (const b of buckets) {
      const labels = byBucket.get(b);
      const probes = {};
      // 用桶内**最新样本时间**而不是桶起点：F4 的 last_down_at/cert_ts 需要真实采样时刻，
      // 桶起点会把「最近一次 down」错误地报成整点，证书倒计时也会平白多扣。
      let ts = 0;
      for (const [label, acc] of labels) {
        probes[label] = finishProbe(acc);
        if (acc.ts > ts) ts = acc.ts;
      }
      rows.push({
        agent_id: aid,
        ts: ts || since + b * bucket,
        probes: JSON.stringify(probes),
      });
    }
  }
  rows.sort((a, b) => (a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : a.ts - b.ts));
  return groupAgent ? rows : rows.map(({ ts, probes }) => ({ ts, probes }));
}

const probesOne = (db, agentId, since, maxPoints) => {
  const bucket = spanBucket(since, null, maxPoints);
  return probeRows(db, { agentId, since, until: null, bucket, groupAgent: false });
};

const probesAll = (db, since, maxPoints) => {
  const bucket = spanBucket(since, null, maxPoints);
  return probeRows(db, { since, until: null, bucket, groupAgent: true });
};

module.exports = {
  LOAD_SPEC,
  SPARK_SPEC,
  RANGE_SPEC,
  detailDays,
  watermark,
  effectiveDetailStart,
  weightedRows,
  loadOne,
  loadAll,
  sparklinesOne,
  sparklinesAll,
  rangeSampled,
  clusterAvg,
  diskTrendAll,
  trafficEstimate,
  probesOne,
  probesAll,
};
