'use strict';
// 游客视图域（/public/*）：全部只读，受 ui_settings.public_enabled 控制。
// 由 api.js 原样搬移（P2-1 拆分第五域），对外路径与行为零变化。

const express = require('express');
const db = require('../db');
const online = require('../online');
const { heavyQuery } = require('../heavy-db');
const hardware = require('../hardware-profile');
const { convertSummary, summarizeByCurrency, computeBilling } = require('../billing');
const theme = require('../theme');
const { asyncHandler } = require('../util');
const { adminOnly, agentScope } = require('../auth');
const { agentGlobalOnly } = require('./_shared');
const {
  publicDisabled, getUptime30d, parseCustomWindow, RANGES,
  PROBES_DOWNSAMPLE, PROBES_MAX_POINTS, clampInt, sparkMaxPoints,
  downsampleSparklines, shortHost, parseDisks,
} = require('./_public-helpers');

const router = express.Router();

// ---- Public（游客）视图：无需登录，受 ui_settings.public_enabled 控制 ----
// 返回脱敏概览（仅总数/在线/离线/分组），不含任何敏感指标均值。
router.get('/public/overview', (req, res) => {
  const ui = db.getUiSettings();
  if (ui.public_enabled === false) return publicDisabled(res);
  const octx = online.buildCtx();
  const now = Date.now();
  const agents = db.getMonitoredAgents();
  let onlineCount = 0;
  let cpuSum = 0, memSum = 0, cpuCount = 0, memCount = 0;
  const groups = {};
  for (const a of agents) {
    const isOn = online.isOnline(a, now, octx);
    if (isOn) {
      onlineCount++;
      const m = db.getLatestMetric(a.id);
      if (m) {
        if (typeof m.cpu === 'number') { cpuSum += m.cpu; cpuCount++; }
        if (typeof m.mem_pct === 'number') { memSum += m.mem_pct; memCount++; }
      }
    }
    const g = (a.grp || '').trim() || '未分组';
    const ge = groups[g] || (groups[g] = { total: 0, online: 0 });
    ge.total++; if (isOn) ge.online++;
  }
  res.json({
    total: agents.length, online: onlineCount, offline: agents.length - onlineCount,
    cpu_avg: cpuCount > 0 ? +(cpuSum / cpuCount).toFixed(1) : null,
    mem_avg: memCount > 0 ? +(memSum / memCount).toFixed(1) : null,
    groups: Object.keys(groups).map(name => ({ name, total: groups[name].total, online: groups[name].online })),
    // 资产汇总跟随 public_show_business：关闭业务字段时连总额也不下发，
    // 避免「开关已关但金额还挂在公开概览上」。公开页只拿折算结果，不下发汇率配置。
    ...(ui.public_show_business !== false
      ? { billing: convertSummary(summarizeByCurrency(agents, now), ui.billing) }
      : {})
  });
});

// 公开 agent 列表（游客可见，受 ui_settings.public_enabled 控制）。
// 默认透出商家/到期/备注/配额/套餐等业务字段——这是公开页首页「商家数、即将到期」
// 与详情页「备注、套餐卡片」的数据来源，故不能简单删除；
// 改由 ui_settings.public_show_business 统一开关：面向外部访客的站点可在后台关闭，
// 关闭后这些字段直接不出现在响应里（而非返回空串），避免"字段在但值为空"的误判。
router.get('/public/agents', (req, res) => {
  const ui = db.getUiSettings();
  if (ui.public_enabled === false) return publicDisabled(res);
  const showBiz = ui.public_show_business !== false;
  // 硬件档案全局开关：关闭后所有公开出口统一输出空值（字段级 hidden 仍生效）
  const showHw = ui.public_show_hardware !== false;
  // 在线判定统一走 src/online.js（此前只看 OFFLINE_THRESHOLD_SEC，
  // 公开首页的在线绿点会与告警/面板判定不一致）；批量场景预取上下文避免逐节点查库。
  const octx = online.buildCtx();
  const now = Date.now();
  const uptime30d = getUptime30d();
  const list = db.getMonitoredAgents().map((a) => {
    const latest = db.getLatestMetric(a.id);
    const isOn = online.isOnline(a, now, octx);
    const m = isOn && latest ? latest : null;
    const base = {
      id: a.id, name: a.name, group: a.grp || '',
      // F7：30 天在线率（%，1 位小数）；null = 窗口内还没有任何 session 记录
      uptime_30d: uptime30d[a.id] ?? null,
      country: a.country || '',
      online: !!isOn,
      cpu: m ? m.cpu : null,
      mem_pct: m ? m.mem_pct : null,
      mem_total: m ? m.mem_total : 0,
      mem_used: m ? m.mem_used : 0,
      disk_pct: m ? m.disk_pct : null,
      disk_used: m ? m.disk_used : 0,
      disk_total: m ? m.disk_total : 0,
      disk_r_rate: m ? m.disk_r_rate : 0,
      disk_w_rate: m ? m.disk_w_rate : 0,
      load1: m ? m.load1 : null,
      load5: m ? m.load5 : null,
      load15: m ? m.load15 : null,
      // 进程总数（Windows 卡片显示；0/未采集 → null，前端显示 '—'）
      process_count: m && m.process_count ? m.process_count : null,
      temp: m ? m.temp : null,
      swap_pct: m ? m.swap_pct : null,
      swap_used: m ? m.swap_used : 0,
      swap_total: m ? m.swap_total : 0,
      net_rx_rate: m ? m.net_rx_rate : 0,
      net_tx_rate: m ? m.net_tx_rate : 0,
      net_rx_month: m ? m.net_rx_month : 0,
      net_tx_month: m ? m.net_tx_month : 0,
      month_rotate: a.month_rotate ?? null,
      has_counter: db.hasTrafficCounter(a.id),
      uptime: m ? m.uptime : 0,
      os: (m && m.os) ? m.os : (a.os || ''),
      // CPU 核心数（agents.cores，S1/T18 采集；0 = 未上报，前端据此显示「—」）
      cores: Number(a.cores) || 0,
      // 硬件/系统档案（管理员手工录入，受控端不自动采集）：
      // cpu_name/arch/virtualization/gpu_name/kernel_version。未填写或隐藏时为空串。
      ...hardware.publicFields(a, showHw),
      probes: m ? (m.probes || '') : '',
      hostname: online ? shortHost(a.hostname) : '',
      disks: m ? parseDisks(m.disks) : []
    };
    if (!showBiz) return base;
    // 业务字段（商家/到期/备注/配额/套餐）：受 public_show_business 开关控制
    return Object.assign(base, {
      merchant: a.merchant || '',
      expire_at: a.expire_at || '',
      note: a.note || '',
      monthly_quota_gb: a.monthly_quota_gb || 0,
      price: a.price || 0,
      billing_cycle: a.billing_cycle || 30,
      currency: a.currency || '¥',
      // 剩余价值 / 月均支出 / 剩余天数（参考面板口径，见 src/billing.js）
      ...computeBilling(a)
    });
  });
  res.json(list);
});

// 公开历史曲线（脱敏，仅指标时序，无 token / 备注 / 商家等敏感字段）。
// 供「视觉版」首页卡片渲染 sparkline。受 ui.public_enabled 控制。
// 注意：无 id 的全量查询在 100 台规模下数据量巨大，后端做时间桶降采样（见 downsampleSparklines）
// 并把结果按 range+id 缓存 30s，避免前端并发刷新时重复跑大查询把服务端打挂（DoS 级瓶颈）。

const sparkCache = new Map(); // key: `${range}|${onlyId}` 或 `c:${since}:${until}|${id}` -> { ts, data }
const SPARK_CACHE_TTL = 30000;
// 自定义窗口的 cacheKey 含毫秒级时间戳，键空间无限；公开端点可被灌入不同窗口撑大内存。
// 写入前先清过期项，再按容量淘汰最旧（Map 保插入序），把缓存条目数钉死。
const SPARK_CACHE_MAX = 256;
function sparkCachePut(key, data) {
  const now = Date.now();
  for (const [k, v] of sparkCache) {
    if (now - v.ts >= SPARK_CACHE_TTL) sparkCache.delete(k);
  }
  while (sparkCache.size >= SPARK_CACHE_MAX) {
    const oldest = sparkCache.keys().next().value;
    if (oldest === undefined) break;
    sparkCache.delete(oldest);
  }
  sparkCache.set(key, { ts: now, data });
}


// 无 id 全量请求（首页卡片迷你图）每 agent 点数上限：100 台规模下控制传输量
const SPARK_ALL_MAX_POINTS = 120;
router.get('/public/agents/sparklines', asyncHandler(async (req, res) => {
  const ui = db.getUiSettings();
  if (ui.public_enabled === false) return publicDisabled(res);
  const range = RANGES[req.query.range] ? req.query.range : '7d'; // 无效 range 兜底 7d
  const win = parseCustomWindow(req.query);
  if (win && win.error) return res.status(400).json({ error: win.error });
  const custom = !!win;
  const since = custom ? win.since : Date.now() - RANGES[range] * 1000;
  const until = custom ? win.until : Date.now();
  // 非自定义窗口传 null，保持既有「不设上界」行为不变。
  const sqlUntil = custom ? until : null;
  const onlyId = typeof req.query.id === 'string' && req.query.id ? req.query.id : null;
  const cacheKey = custom ? `c:${since}:${until}|${onlyId || '*'}` : `${range}|${onlyId || '*'}`;
  const cached = sparkCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SPARK_CACHE_TTL) {
    return res.json(cached.data);
  }
  // 游客详情页只需单节点历史，避免拉全量；缺省行为保持全量兼容。
  // 用只含指标列（不含 probes 大字段）的轻量查询，避免 SELECT * 物化全行（30d 5.3s -> 2.3s）
  // 无 id 全量请求：SQL 层窗口函数采样（757K 行→~7200 行，减少 100x 传输+JS 处理）。
  // 有 id 单节点请求（详情页）：同样走 SQL 层采样 metricsSparklinesOne。
  //   此前单节点是「全量拉 10.8 万行 → Node 侧降采样」，每次 2.77s + 220MB 峰值，
  //   30s 缓存一过就慢/偶发超时（详情页图表"慢/有时无法显示"）。SQL 层直接只返回 maxPoints 行。
  const mp = clampInt(req.query.max_points, 60, 20000)
    || (onlyId ? (custom ? 2000 : sparkMaxPoints(range)) : SPARK_ALL_MAX_POINTS);
  // 审查 C4：全量分支（首页卡片迷你图，100 台规模最重）移 worker 线程；
  // 单节点分支（详情页）行数有界，保留主线程同步路径。
  // until 必须下推到 SQL：merge 层用 (until - since) 反推桶宽，并在 WHERE 里加 ts < until。
  // 否则历史窗口会按 (now - since) 定桶宽、把窗口内数据稀释，末点还会被窗口外的明细覆盖后丢掉。
  const rows = onlyId
    ? db.getMetricsSparklinesOne(onlyId, since, mp, sqlUntil)
    : await heavyQuery('sparklinesAllSampled', since, mp, sqlUntil);
  // 后端降采样（对齐参考面板 max_points 契约）。
  // 无 id 的全量请求（首页卡片迷你图，只需 ~120 点/agent）：用独立小上限 SPARK_ALL_MAX_POINTS，
  // 避免 100 台规模下返回 1500 点/agent 造成 40MB+ 传输灾难。
  // 有 id 的单节点请求（详情页磁盘耗尽预测）：SQL 层已按 range 上限采样（30d→2000 足够线性外推），
  // 此处 downsampleSparklines 仅作幂等兜底（SQL 采样已保留首尾点，若点数已≤mp 会原样返回）。
  // since/until 均已由 SQL WHERE 限定；这里保留一次兜底过滤，防御 worker 回落路径的口径差异。
  const byAgent = downsampleSparklines(rows.filter(r => r.ts >= since && r.ts <= until), mp);
  for (const id of Object.keys(byAgent)) {
    byAgent[id] = byAgent[id].map(r => ({
      ts: r.ts, cpu: r.cpu, mem_pct: r.mem_pct, disk_pct: r.disk_pct,
      net_rx_rate: r.net_rx_rate, net_tx_rate: r.net_tx_rate,
      load1: r.load1, temp: r.temp, swap_pct: r.swap_pct, uptime: r.uptime,
      disk_r_rate: r.disk_r_rate, disk_w_rate: r.disk_w_rate,
      // Windows 卡片进程胶囊的迷你图（0/未采集 → null，前端显示 '—'）
      process_count: r.process_count || null,
      // 磁盘耗尽预测用：整机已用/总字节时序（对齐上游 MetricDisk 口径）
      disk_used: r.disk_used, disk_total: r.disk_total
    }));
  }
  sparkCachePut(cacheKey, byAgent);
  res.json(byAgent);
}));

// 公开单节点在线时段历史（F7，脱敏）：详情页在线率卡用。
// 与 admin 版同一份口径，只是去掉权限；受 ui.public_enabled 控制。
router.get('/public/agents/:id/online-history', (req, res) => {
  const ui = db.getUiSettings();
  if (ui.public_enabled === false) return publicDisabled(res);
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const days = Math.min(90, Math.max(1, Math.floor(Number(req.query.days) || 30)));
  res.json(db.onlineHistory(a.id, days));
});

// 公开单节点探针延迟历史（脱敏）：详情页 ping 值延迟分析图表用。
// 从 metrics.probes 历史读取，按探测点 label 归并，返回每个探测点的延迟时间序列。
// 受 ui.public_enabled 控制；range 支持 1h/4h/6h/12h/24h/7d/30d，或自定义 start/end（≤30 天）。
// ?availability=1（F4）额外返回可用率聚合 { series, availability }，缺省保持原
// 「纯 series 对象」形状不变——社区主题/既有调用方零影响。
router.get('/public/agents/:id/probes', asyncHandler(async (req, res) => {
  const ui = db.getUiSettings();
  if (ui.public_enabled === false) return publicDisabled(res);
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  // 自定义时间窗（对齐 Glass PingChart 的「自定义」），规则与 sparklines 完全一致。
  const win = parseCustomWindow(req.query);
  if (win && win.error) return res.status(400).json({ error: win.error });
  const custom = !!win;
  const since = custom ? win.since : Date.now() - (RANGES[req.query.range] || 21600) * 1000;
  const until = custom ? win.until : Date.now();
  // 提前算出本请求的每 label 点数上限（供 SQL 层采样 + 后续桶聚合共用）。
  const reqMaxPoints = clampInt(req.query.max_points) || PROBES_MAX_POINTS;
  // 仅取 ts+probes 两列：30d 近 9.5 万行，SELECT * 物化全行开销大（实测 5.4s vs 0.56s）
  // 再叠加 SQL 层采样：全量 9.5 万行 → maxPoints 行，逐行 JSON.parse 次数同比骤降。
  // 采样点数取 max(上限, 5000) 的 3 倍冗余，保证后续 avg 桶聚合仍有足够样本、统计不失真。
  //
  // F4 收口：取数走 **worker**（heavyQuery('probesOne')），不再在主线程跑这段 SQL。
  // 理由：公开端点未认证即可触发，30d 窗口的采样 + JSON.parse 在主线程会阻塞事件循环
  // （期间 /report 与告警全部挂起）。worker 不可用时 heavy-db 自动回落主线程同步执行，
  // 行为与改造前完全一致（可用性优先）。
  // until 下推到 worker 的 SQL：避免扫描/JSON.parse 窗口结束后的全部行，并让桶宽按窗口长度计算。
  const rows = await heavyQuery('probesOne', a.id, since, Math.min(20000, Math.max(reqMaxPoints, PROBES_MAX_POINTS) * 3), custom ? until : null);
  const wantAvail = req.query.availability === '1' || req.query.availability === 'true';
  const series = {}; // label -> [{ts, ms}]
  // 可用率累加器（F4）：只统计采样后的原始上报点，不受下面时间桶聚合影响；
  // SQL 采样是均匀抽样（metricsProbesOne 的 rn % step），对 up/down 比例无系统偏差。
  const stats = wantAvail ? {} : null;
  for (const r of rows) {
    if (r.ts > until) continue;
    if (!r.probes) continue;
    let probes;
    try { probes = JSON.parse(r.probes); } catch { continue; }
    if (!probes || typeof probes !== 'object') continue;
    for (const [label, p] of Object.entries(probes)) {
      if (!p || typeof p !== 'object') continue;
      // S3 三态：ok=null 表示无采样（解析超时），既不是成功也不是失败
      const ok = (p.ok === null || p.ok === undefined) ? null : p.ok !== false;
      const ms = typeof p.ms === 'number' ? Math.round(p.ms) : null;
      const loss = typeof p.loss === 'number'
        ? Math.round(p.loss)
        : (p.loss === null ? null : (ok === false ? 100 : (ok ? 0 : null)));
      // P0-3：桶内布尔样本计数透传（合并层 finishProbe 输出 n_ok/n_samp）；
      // 旧形状无计数时按单样本回退，保证加权口径统一
      const nSamp = Number.isFinite(Number(p.n_samp)) ? Number(p.n_samp) : (ok !== null ? 1 : 0);
      const nOk = nSamp > 0
        ? (Number.isFinite(Number(p.n_ok)) ? Math.min(Number(p.n_ok), nSamp) : (ok === true ? nSamp : 0))
        : 0;
      if (!series[label]) series[label] = [];
      series[label].push({
        ts: r.ts, ms, ok, loss, n_ok: nOk, n_samp: nSamp,
        ok_rate: nSamp ? Math.round((nOk / nSamp) * 10000) / 10000 : null,
      });
      // 可用率按样本数加权（Σn_ok/Σn_samp），不再按桶等权
      if (stats && nSamp > 0) {
        const st = stats[label] || (stats[label] = {
          samples: 0, up: 0, msSum: 0, msCnt: 0, maxMs: null, lastDownAt: null, latest: null
        });
        st.samples += nSamp;
        st.up += nOk;
        if (ms !== null) {
          st.msSum += ms;
          st.msCnt++;
          if (st.maxMs === null || ms > st.maxMs) st.maxMs = ms;
        }
        if (ok === false) st.lastDownAt = r.ts;
        // rows 按 ts ASC，最后写入即最新一条
        st.latest = {
          ts: r.ts,
          type: p.type === 'http' ? 'http' : 'tcp',
          code: typeof p.code === 'number' ? p.code : null,
          cert_days: typeof p.cert_days === 'number' ? p.cert_days : null
        };
      }
    }
  }
  if (PROBES_DOWNSAMPLE) {
    // 请求参数化降采样（对齐参考面板 downsample/max_points/aggregation 契约）：
    //   max_points=N：每 label 目标点数上限（缺省用 PROBES_MAX_POINTS）。以该值反推动态桶宽做时间桶聚合。
    //   aggregation=avg|last：avg（默认，对齐参考面板）取桶内延迟平均；last 取桶内最后一个点。
    const maxPoints = reqMaxPoints;
    const agg = req.query.aggregation === 'last' ? 'last' : 'avg';
    for (const label of Object.keys(series)) {
      const arr = series[label];
      if (arr.length <= maxPoints) continue; // 点数本就不多，无需聚合
      const span = arr[arr.length - 1].ts - arr[0].ts;
      const bucket = Math.max(1, Math.ceil(span / maxPoints)); // 以 max_points 为目标反推桶宽
      const map = new Map();
      const order = [];
      for (const pt of arr) {
        const key = Math.floor(pt.ts / bucket) * bucket;
        if (!map.has(key)) {
          map.set(key, {
            ts: pt.ts,
            ms: pt.ms, // last 模式用桶内第一个点
            ok: pt.ok, loss: pt.loss,
            // avg 累加器：ms/loss 只对有值样本求均值；可达计数按 n_ok/n_samp 加权（P0-3）
            sumMs: pt.ms != null ? pt.ms : 0, cntMs: pt.ms != null ? 1 : 0,
            okCnt: pt.n_ok || 0, sampCnt: pt.n_samp || 0,
            sumLoss: pt.loss != null ? pt.loss : 0, cntLoss: pt.loss != null ? 1 : 0
          });
          order.push(key);
        } else {
          const cur = map.get(key);
          cur.ts = pt.ts;
          if (pt.ms != null) { cur.sumMs += pt.ms; cur.cntMs++; }
          cur.okCnt += pt.n_ok || 0;
          cur.sampCnt += pt.n_samp || 0;
          if (pt.loss != null) { cur.sumLoss += pt.loss; cur.cntLoss++; }
          if (agg === 'last' && pt.ms != null) cur.ms = pt.ms; // last 模式覆盖为桶内最后一个有效点
        }
      }
      series[label] = order.map(k => {
        const b = map.get(k);
        if (agg === 'avg') {
          return {
            ts: b.ts,
            ms: b.cntMs ? Math.round(b.sumMs / b.cntMs) : null,
            // 桶内全无采样 → ok=null（不是失败）；ok 保留「任一成功即可达」供兼容，
            // 混合桶真实达成率看 ok_rate（P0-3：不再冒充 100%）
            ok: b.sampCnt ? b.okCnt > 0 : null,
            loss: b.cntLoss ? Math.round(b.sumLoss / b.cntLoss) : null,
            ok_rate: b.sampCnt ? Math.round((b.okCnt / b.sampCnt) * 10000) / 10000 : null
          };
        }
        return { ts: b.ts, ms: b.ms, ok: b.ok, loss: b.loss };
      });
    }
  }

  if (wantAvail) {
    const availability = {};
    for (const [label, st] of Object.entries(stats)) {
      availability[label] = {
        // 保留 1 位小数：99.9%/99.95% 的差异对可用性判断有意义，整数会把它们抹平。
        up_pct: st.samples ? Math.round((st.up / st.samples) * 1000) / 10 : null,
        samples: st.samples,
        down_samples: st.samples - st.up,
        avg_ms: st.msCnt ? Math.round((st.msSum / st.msCnt) * 10) / 10 : null,
        max_ms: st.maxMs,
        last_down_at: st.lastDownAt,
        // 窗口内全部失败 ≠ 「0% 可用」：多半是目标本身不可达（运营商 DNS 拒 TCP 等），
        // 前端据此显示「不可达」，避免被误判成探测链路故障。
        unreachable: st.samples > 0 && st.up === 0,
        type: st.latest ? st.latest.type : 'tcp',
        code: st.latest ? st.latest.code : null,
        cert_days: st.latest ? st.latest.cert_days : null,
        cert_ts: st.latest ? st.latest.ts : null
      };
    }
    return res.json({ series, availability });
  }
  res.json(series);
}));

// 游客视图元信息（无需登录）：站点标题、是否开放、首页默认布局、卡片排序。
router.get('/public/meta', (req, res) => {
  const ui = db.getUiSettings();
  let agentOrder = [];
  try { agentOrder = JSON.parse(db.getConfig('public_order') || '[]'); } catch {}
  res.json({
    site_title: ui.site_title || '',
    site_url: ui.site_url || '',
    logo_url: ui.logo_url || '/logo.png',
    public_enabled: !!ui.public_enabled,
    home_layout: ui.home_layout || 'grid',
    agent_order: Array.isArray(agentOrder) ? agentOrder : [],
    social_email: ui.social_email || '',
    social_telegram: ui.social_telegram || '',
    social_qq: ui.social_qq || '',
    social_website: ui.social_website || '',
    // 主题可视化配置（对齐玻璃拟态主题）
    glass_preset: ui.glass_preset || 'emerald',
    glass_custom: ui.glass_custom || {},
    color_vision: ui.color_vision || 'normal',
    card_scheme: ui.card_scheme || 'official',
    card_size: ui.card_size || 'comfortable',
    // 暗/亮两套背景配置（兼容旧版单 background 字段作为暗色回退）
    background_dark: ui.background_dark || ui.background || { enabled: false, type: 'image', url: '', blur: 8, overlay: 50 },
    background_light: ui.background_light || { enabled: false, type: 'image', url: '', blur: 8, overlay: 50 },
    announcement: ui.announcement || { enabled: false, title: '', content: '' },
    provider_aliases: ui.provider_aliases || {},
    custom_tags: ui.custom_tags || {},
    visitor_info: !!ui.visitor_info
  });
});

// 访客信息条（对齐上游主题的 visitorInfoEnabled）：返回访客 IP 与 UA 摘要。
router.get('/public/visitor', (req, res) => {
  const fwd = req.headers['x-forwarded-for'];
  let ip = req.ip || (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const ua = req.headers['user-agent'] || '';
  let browser = 'Unknown';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  res.json({ ip, browser, ua: ua.slice(0, 80) });
});

// 游客页卡片自定义排序（需管理员会话，避免游客随意更改全局顺序）。
// 管理员在前台拖拽后调用此接口，所有人访问即看到固定顺序。
router.post('/public/order', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const order = (req.body && Array.isArray(req.body.order))
    ? req.body.order.filter(x => typeof x === 'string').slice(0, 2000)
    : [];
  db.setConfig('public_order', JSON.stringify(order));
  res.json({ ok: true });
});

// 列出可用主题（安装目录 + 只读内置目录）供后台「皮肤模板」选择。无需登录。
// 保持历史契约：id = short，name/description 已归一化为字符串（不返回 i18n map）。
// 刻意不做 public_enabled 门控：public_enabled=false 时后台主题下拉仍依赖本接口，
// 且这里只暴露主题名/版本，无监控业务数据。
router.get('/public/themes', (req, res) => {
  res.json(theme.listInstalledThemes().map((t) => ({
    id: t.short,
    short: t.short,
    name: t.name,
    description: t.description,
    version: t.version,
    author: t.author,
    preview: t.preview,
    bundled: t.bundled,
    configurable: t.configurable
  })));
});



module.exports = router;
