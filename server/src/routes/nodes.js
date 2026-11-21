'use strict';
// 节点域（/agents*）：列表 / 曲线 / 详情 / 在线率 / 集群趋势，
// 以及创建、更新、删除、恢复、流量修正、令牌重置、续期、安装命令。
// 由 api.js 原样搬移，路由相对顺序保持不变（sparklines 必须先于 :id）。

const express = require('express');
const db = require('../db');
const { heavyQuery } = require('../heavy-db');
const online = require('../online');
const alerts = require('../alerts');
const hardware = require('../hardware-profile');
const { computeBilling } = require('../billing');
const { nextExpire } = require('../renew');
const { asyncHandler } = require('../util');
const { str, num } = require('../validate');
const {
  adminOnly, adminOrReadonly, agentScope, inAgentScope, auditLog,
} = require('../auth');
const {
  agentGlobalOnly, diffKeys, getPublicBaseUrl, serverUrlUnconfigured,
  buildInstallCommands, buildModifyCommands, AGENT_INTERVAL_DEFAULT,
  isValidCurrency, isValidCycle,
} = require('./_shared');
const {
  shortHost, parseDisks, RANGES, RANGE_POINTS, clampInt, sparkMaxPoints, downsampleSparklines,
} = require('./_public-helpers');

const router = express.Router();

// ---- Admin: 批准自助注册的待确认 agent（审查 G4）----
// 待确认 agent 无法上报也不进看板；管理员在后台批准后放行。
router.post('/agents/:id/approve', adminOnly, agentScope, asyncHandler(async (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!a.pending) return res.json({ ok: true, id: a.id, pending: false, message: 'already approved' });
  if (!db.approveAgent(a.id)) return res.status(500).json({ error: 'approve failed' });
  auditLog(req, 'agent_approve', `id=${a.id}`);
  res.json({ ok: true, id: a.id, pending: false });
}));

// ---- Admin: list agents + latest metric + online status ----
router.get('/agents', adminOrReadonly, agentScope, (req, res) => {
  const now = Date.now();
  // S1/F1：在线判定与告警同源——按「节点 > 分组 > 全局」解析 offlineSec，
  // 避免出现「看板显示在线、告警判离线」的双源分裂（历史审查 C-1/E2 同类问题）。
  const ctx = {
    global: db.resolveAlertThresholds(),
    groupCache: new Map(db.listGroupAlertOverrides().map((r) => [r.grp, r])),
    nodeCache: new Map(db.listAlertOverrides().map((r) => [r.agent_id, r]))
  };
  // P2-2：批量取最新指标，消除逐节点 N+1（100 节点 = 1 次查询）
  const latestMap = db.getLatestMetricsMap();
  // S2/F5：带节点白名单的 API Token 只看到授权范围内的节点。
  const list = db.getAgents().filter((a) => inAgentScope(req, a.id)).map((a) => {
    const latest = latestMap.get(a.id) || null;
    const eff = alerts.resolveAgentThresholds(a, ctx);
    const online = a.last_seen && (now - a.last_seen) < eff.offlineSec * 1000;
    const latestOut = latest ? Object.assign({}, latest, { disks: parseDisks(latest.disks) }) : null;
    const out = Object.assign({}, a, {
      group: a.grp || '',
      online: !!online,
      // 剩余价值/月均支出（参考面板口径，见 src/billing.js）
      ...computeBilling(a, now),
      has_counter: db.hasTrafficCounter(a.id),
      latest: latestOut,
      hostname: shortHost(a.hostname),
      // 硬件档案（解析为对象；列表页不编辑，仅用于详情页初始化与刷新）
      hardware: hardware.parseProfile(a.hw_profile),
      alert: {
        effective: {
          offline_sec: eff.offlineSec,
          cpu_pct: eff.cpuAlert,
          mem_pct: eff.memAlert,
          disk_pct: eff.diskAlert,
          temp_c: eff.tempAlert,
          cooldown: eff.cooldown
        },
        overridden: ctx.nodeCache.has(a.id),
        muted: eff.muted
      }
    });
    delete out.token_hash; // P2-2：凭据哈希不出接口
    return out;
  });
  res.json(list);
});



// ---- Admin: batch sparkline history for all agents (avoids N+1 on the frontend) ----
router.get('/agents/sparklines', adminOrReadonly, agentScope, asyncHandler(async (req, res) => {
  const range = req.query.range;
  const sec = RANGES[range] || 21600;
  // 管理端 sparklines：用轻量列查询（不含 probes 大字段）+ SQL 层采样，避免 SELECT * 物化全行。
  const mp = clampInt(req.query.max_points, 60, 20000) || sparkMaxPoints(range);
  // 审查 C4：重聚合移 worker 线程执行——同步执行会阻塞事件循环数秒，
  // 期间 /report、告警、全部请求一并挂起。
  let rows = await heavyQuery('sparklinesAllSampled', Date.now() - sec * 1000, mp);
  // S2/F5：节点白名单过滤（行内含 agent_id）
  if (req.agentScope) rows = rows.filter((r) => req.agentScope.has(String(r.agent_id)));
  res.json(downsampleSparklines(rows, mp));
}));

// ---- Admin: 集群平均 CPU/内存趋势（仪表盘专用）----
// 与 /agents/sparklines 不同：不做「每 agent 原始点」，而是由 SQL 引擎跨所有 agent 按时间桶
// 直接聚合出集群平均曲线，只返回 ≤maxPoints 行（几十~几百个点）。彻底消除前端拉 62 台全量
// 再逐点聚合的主线程卡顿。max_points 缺省用 sparkMaxPoints，与右侧趋势图桶粒度一致。
router.get('/agents/sparklines/overview', adminOrReadonly, agentScope, asyncHandler(async (req, res) => {
  // S2/F5：集群聚合面不向节点白名单 Token 开放（会泄露全局规模/均值）。
  if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
  const range = req.query.range;
  const sec = RANGES[range] || 21600;
  const mp = clampInt(req.query.max_points, 60, 20000) || sparkMaxPoints(range);
  // 审查 C4：重聚合移 worker 线程执行，避免阻塞事件循环
  const rows = await heavyQuery('clusterAvg', Date.now() - sec * 1000, sec * 1000, mp);
  // rows: [{ts, cpu, mem_pct}]，桶内已有集群平均，直接返回
  res.json(rows.map(r => ({
    ts: r.ts,
    cpu: r.cpu == null ? null : +r.cpu.toFixed(2),
    mem_pct: r.mem_pct == null ? null : +r.mem_pct.toFixed(2)
  })));
}));

// ---- Admin: 最近删除（F11，7 天缓冲）----
// 必须注册在 /agents/:id 之前，否则会被 :id 路由吞掉。
router.get('/agents/deleted', adminOrReadonly, agentScope, (req, res) => {
  const now = Date.now();
  const graceMs = 7 * 86400000;
  const items = db.listDeletedAgents()
    .filter((a) => inAgentScope(req, a.id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      hostname: shortHost(a.hostname),
      version: a.version || '',
      deleted_at: a.deleted_at,
      days_left: Math.max(0, Math.ceil((a.deleted_at + graceMs - now) / 86400000))
    }));
  res.json({ items, grace_days: 7 });
});

// ---- Admin: single agent info ----
// ---- Admin: 硬件档案候选清单（预设枚举；前端下拉经此取，不前后端各存一份）----
router.get('/hardware-options', adminOrReadonly, (req, res) => {
  res.json(hardware.options());
});

router.get('/agents/:id', adminOrReadonly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const latest = db.getLatestMetric(a.id);
  // 与 /agents 列表同源（逐节点阈值），避免列表说在线、详情说离线
  const isOnlineNow = online.isOnline(a);
  const latestOut = latest ? Object.assign({}, latest, { disks: parseDisks(latest.disks) }) : null;
  res.json(Object.assign({}, a, {
    group: a.grp || '',
    online: isOnlineNow,
    latest: latestOut,
    hostname: shortHost(a.hostname),
    // 硬件档案（解析为对象便于前端编辑；原始字符串仍在 a.hw_profile 中）
    hardware: hardware.parseProfile(a.hw_profile),
    ...computeBilling(a)
  }));
});


router.get('/agents/:id/metrics', adminOrReadonly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const sec = RANGES[req.query.range] || 3600;
  // points 可显式覆盖（60–1440），供前端按需调整密度
  const points = Math.min(1440, Math.max(60, Number(req.query.points) || RANGE_POINTS[req.query.range] || 360));
  // getMetricsSampled 内部为 metricsRangeSampled，同为 SELECT *（全列，含 probes/disks），
  // 故响应 shape 与旧实现一致、前端零改动；收益来自行数下降而非列裁剪
  // （若需进一步压单行字节，须改显式列，但那会破坏 shape 兼容 —— 留作后续独立优化）。
  const rows = db.getMetricsSampled(req.params.id, Date.now() - sec * 1000, points);
  res.set('X-Sampled', '1');
  res.json(rows);
});

// ---- Admin: 在线时段历史（F7）----
// daily 按主机本地日切分（SQL/JS 都用 localtime 语义，避免 UTC+8 下错位 8 小时）；
// outages 只列窗口内的离线缺口，进行中的缺口 ended_at=null、duration 持续增长。
router.get('/agents/:id/online-history', adminOrReadonly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const days = Math.min(90, Math.max(1, Math.floor(Number(req.query.days) || 30)));
  res.json(db.onlineHistory(a.id, days));
});


// ---- Admin: create agent ----
router.post('/agents', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  // 校验必须前置到写操作之前：否则会在拿不到安装命令的情况下白白创建一个 agent。
  const base = getPublicBaseUrl();
  if (!base) return serverUrlUnconfigured(res);
  // 探测目标：建客户端时未显式填写则回退到「设置」里的全局默认（不同地域可单独覆盖）。
  const ui = db.getUiSettings();
  const probeTargets = str(req.body.probe_targets, 600) || ui.probe_targets || '';
  const price = Number(req.body.price);
  const cycleNum = Number(req.body.billing_cycle);
  // 硬件档案（可选）：管理员手工录入；非法枚举/超长文本 → 400，不静默丢弃。
  let hwProfile = '';
  if (req.body && req.body.hardware !== undefined) {
    const v = hardware.normalizeProfile(req.body.hardware);
    if (!v.ok) return res.status(400).json({ error: v.error });
    hwProfile = Object.keys(v.value).length ? JSON.stringify(v.value) : '';
  }
  const { id, token } = db.createAgent({
    name: str(req.body.name, 100) || undefined,
    merchant: str(req.body.merchant, 100),
    note: str(req.body.note, 500),
    expire_at: str(req.body.expire_at, 40),
    monthly_quota_gb: req.body.monthly_quota_gb,
    price: Number.isFinite(price) ? Math.max(-1, Math.min(99999, price)) : undefined,
    billing_cycle: Number.isFinite(cycleNum) && isValidCycle(cycleNum) ? cycleNum : undefined,
    currency: isValidCurrency(req.body.currency) ? req.body.currency : undefined,
    auto_renewal: typeof req.body.auto_renewal === 'boolean' ? req.body.auto_renewal : undefined,
    grp: str(req.body.group, 60),
    country: str(req.body.country, 2),
    probe_targets: probeTargets,
    hw_profile: hwProfile
  });
  // 创建时一次性把「地址 + 该客户端令牌 + 探测目标」预填进一键命令返回（令牌仅此刻明文可用）。
  const install = buildInstallCommands(base, id, token, AGENT_INTERVAL_DEFAULT, probeTargets, 0);
  res.json({ id, token, install });
  auditLog(req, 'create_agent', `name=${req.body.name || ''} id=${id}`);
});

// ---- Admin: update agent metadata ----
router.put('/agents/:id', adminOnly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const priceUp = Number(req.body.price);
  const cycleUp = Number(req.body.billing_cycle);
  const updates = {
    name: str(req.body.name, 100) || a.name,
    merchant: str(req.body.merchant, 100),
    note: str(req.body.note, 500),
    expire_at: str(req.body.expire_at, 40),
    monthly_quota_gb: req.body.monthly_quota_gb,
    grp: str(req.body.group, 60),
    country: str(req.body.country, 2),
    probe_targets: str(req.body.probe_targets, 600)
  };
  // P3：month_rotate 三态更新。仅当请求体显式携带该字段时才写；null=回到“采纳 agent 上报”。
  if (Object.prototype.hasOwnProperty.call(req.body, 'month_rotate')) {
    if (req.body.month_rotate === null) {
      updates.month_rotate = null;
    } else {
      const rotate = num(req.body.month_rotate, 0, 31);
      if (rotate === null || !Number.isInteger(rotate)) {
        return res.status(400).json({ error: 'invalid month_rotate' });
      }
      updates.month_rotate = rotate;
    }
  }
  if (Number.isFinite(priceUp)) updates.price = Math.max(-1, Math.min(99999, priceUp));
  if (Number.isFinite(cycleUp) && isValidCycle(cycleUp)) updates.billing_cycle = cycleUp;
  if (isValidCurrency(req.body.currency)) updates.currency = req.body.currency;
  if (typeof req.body.auto_renewal === 'boolean') updates.auto_renewal = req.body.auto_renewal;
  // 硬件档案：仅当请求体显式携带 hardware 时才写；缺失 = 保留库中原值（与其他可选字段同口径）。
  if (Object.prototype.hasOwnProperty.call(req.body, 'hardware')) {
    const v = hardware.normalizeProfile(req.body.hardware);
    if (!v.ok) return res.status(400).json({ error: v.error });
    updates.hw_profile = Object.keys(v.value).length ? JSON.stringify(v.value) : '';
  }
  db.updateAgent(req.params.id, updates);
  res.json({ ok: true });
  // a 为更新前快照（:818 已取）。注意 updates 是【部分字段】，
  // 直接 diff(a, updates) 会把未提交的列也误判为「变更」（缺失 vs 有值）→
  // 故先取更新后的完整行再比较。
  const aAfter = db.getAgent(req.params.id) || {};
  auditLog(req, 'update_agent', `id=${req.params.id} fields=${diffKeys(a, aAfter)}`);
});

// ---- Admin: delete agent ----
router.delete('/agents/:id', adminOnly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  // F11：软删——节点立即从面板消失，身份与历史保留 7 天，可由 /restore 恢复。
  db.deleteAgent(req.params.id);
  res.json({ ok: true, grace_days: 7 });
  auditLog(req, 'delete_agent', `id=${req.params.id} soft=1`);
});

// F11：恢复软删节点（7 天缓冲期内）。
router.post('/agents/:id/restore', adminOnly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const target = db.getAgentIncludingDeleted(req.params.id);
  if (!target || !target.deleted_at) return res.status(404).json({ error: 'not_deleted' });
  if (db.restoreAgent(req.params.id) === 0) return res.status(404).json({ error: 'not_deleted' });
  res.json({ ok: true });
  auditLog(req, 'restore_agent', `id=${req.params.id}`);
});

// ---- Admin: 手工修正月流量（S1.5，对齐 monitor set_traffic）----
// 场景：换硬件/重装系统后计数器归零、或需要把某段流量从本月剔除。修正值会打「当前周期」戳，
// 否则下一轮上报按旧周期把修正清零。只修提供的字段；last_rx/last_tx 基线不动，
// 后续上报在修正值上继续累加 delta。
// rotate=0（绝对累计）节点的下一轮上报会用计数器绝对值覆盖修正值——该口径下计数器即事实源。
router.patch('/agents/:id/traffic', adminOnly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  if (!db.getAgent(req.params.id)) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const hasRx = body.rx !== undefined && body.rx !== null;
  const hasTx = body.tx !== undefined && body.tx !== null;
  if (!hasRx && !hasTx) return res.status(400).json({ error: 'rx_or_tx_required' });
  // 只接受非负整数（字节数）；显式拒绝而非静默 clamp——流量修正必须可预期
  const parse = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    const i = Math.floor(n);
    return Number.isSafeInteger(i) ? i : null;
  };
  const rx = hasRx ? parse(body.rx) : undefined;
  const tx = hasTx ? parse(body.tx) : undefined;
  if ((hasRx && rx === null) || (hasTx && tx === null)) {
    return res.status(400).json({ error: 'invalid_traffic_value' });
  }
  const out = db.correctTraffic(req.params.id, { rx, tx });
  if (!out) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, id: req.params.id, ...out });
  // 审计带具体数值：流量修正是高危写操作，需要可追溯（非凭据，无脱敏必要）
  auditLog(req, 'traffic_correct', `id=${req.params.id} rx=${rx === undefined ? '-' : rx} tx=${tx === undefined ? '-' : tx}`);
});

// ---- Admin: reset an agent's token (returns new token; old one invalidated) ----
router.post('/agents/:id/reset-token', adminOnly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  // 校验必须前置到轮换之前：resetAgentToken 会让旧 Token 立即失效，若之后才发现无法生成
  // 命令，就会留下「旧 Token 已废、管理员也没有新安装命令」的不可逆状态。
  const base = getPublicBaseUrl();
  if (!base) return serverUrlUnconfigured(res);
  const token = db.resetAgentToken(req.params.id);
  if (!token) return res.status(404).json({ error: 'not found' });
  // 重置后同样回带三条一键命令：用户直接复制重装即可，无需手改环境变量。
  // 探测目标沿用该受控端已保存的值，保证重装后 DNS 保持一致。
  const a = db.getAgent(req.params.id);
  const install = buildInstallCommands(base, req.params.id, token, AGENT_INTERVAL_DEFAULT, a ? a.probe_targets : '', a ? (a.month_rotate ?? 0) : 0);
  res.json({ ok: true, token, install });
  auditLog(req, 'reset_token', `id=${req.params.id}`);
});

// ---- Admin: renew agent（续费一个周期）----
router.post('/agents/:id/renew', adminOnly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  // billing_cycle=0 表示白嫖/免费（无计费周期），须显式保留 0，不能用 || 30 吞掉。
  const cycle = (a.billing_cycle === undefined || a.billing_cycle === null || isNaN(Number(a.billing_cycle))) ? 30 : Number(a.billing_cycle);
  // 全程「本地日历日」口径（体检 L-1）：旧实现用 toISOString()（UTC）格式化，
  // 在 UTC+8 下每次续期早 1 天且逐次累积。计算逻辑抽到 src/renew.js（纯函数，便于 TZ 子进程测试）。
  // cycle<=0（白嫖）续费不改变到期日（保持当前/今天），仅刷新为今天以标识「已确认」。
  const newExpire = nextExpire(a.expire_at, Date.now(), cycle);
  db.updateAgent(a.id, Object.assign({}, a, { expire_at: newExpire }));
  res.json({ ok: true, expire_at: newExpire });
  auditLog(req, 'renew_agent', `id=${a.id} expire_at=${newExpire}`);
});

// ---- Admin: 生成某受控端的「安装命令」与「修改探测目标命令」----
// 修改命令无需 Token（仅改本地 systemd drop-in / bat 后重启），可由管理员按需生成。
// query.probe_targets 可临时覆盖（用于预览不同 DNS 的命令），缺省用该受控端已存值。
router.get('/agents/:id/commands', adminOnly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const base = getPublicBaseUrl();
  if (!base) return serverUrlUnconfigured(res);
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const probeTargets = str(req.query.probe_targets, 600) || a.probe_targets || '';
  const install = buildInstallCommands(base, a.id, '<token>', AGENT_INTERVAL_DEFAULT, probeTargets, a.month_rotate ?? 0);
  const modify = buildModifyCommands(base, a.id, probeTargets);
  res.json({ id: a.id, probe_targets: probeTargets, install, modify });
});


module.exports = router;
