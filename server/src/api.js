const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('./db');
const { agentAuth, adminOrReadonly, adminOnly, agentScope, inAgentScope, auditLog } = require('./auth');
const alerts = require('./alerts');
// 在线判定统一口径（节点覆盖 > 分组覆盖 > 全局，与告警同源）
const online = require('./online');
const capacity = require('./capacity');
const { daysUntil, asyncHandler } = require('./util');
const { autoRenewExpire } = require('./renew');
const { computeBilling, summarizeByCurrency, convertSummary, normalizeCurrency } = require('./billing');
const validators = require('./validate');
const { resolveSetupToken, isWeakSetupToken } = require('./setup-token');

// 共享中间件与纯函数（限流 / 登录防护 / agentGlobalOnly / diffKeys / 安装命令）见 routes/_shared.js。
// 全局限流仍必须在本文件挂载（router.use），且保持在所有路由与子 router 之前。
const {
  rateLimit, agentGlobalOnly, diffKeys, buildInstallCommands, buildModifyCommands,
} = require('./routes/_shared');

router.use(rateLimit);

// ---- helpers ----
const { validateReport, sanitizeCss } = require('./validate');


// ---- 认证域（/setup/*、/login、/logout、/admin/password）：routes/auth.js ----
router.use(require('./routes/auth'));

// ---- 节点域（/agents*）：routes/nodes.js ----
router.use(require('./routes/nodes'));

// ---- Agent report (push) ----
// 自动续费（对齐参考面板 utils/renewal/renewal.go）：
// 受控端每次上报即代表「当前在线」，此时若 auto_renewal 开启且已到期（或今天到期），
// 就把到期日推进一个计费周期。周期 <= 0（白嫖/一次性）不动。
function maybeAutoRenew(agent) {
  if (!agent || !agent.auto_renewal) return;
  const next = autoRenewExpire(agent.expire_at, Date.now(), agent.billing_cycle);
  if (!next) return;
  try {
    // updateAgent 是全字段写入：必须先把现有行合并进去，否则未提交字段会被清空
    db.updateAgent(agent.id, { ...agent, expire_at: next });
    console.log(`[renew] auto-renewed ${agent.name || agent.id}: ${agent.expire_at} -> ${next}`);
  } catch (e) {
    console.warn('[renew] auto-renew failed:', e && e.message);
  }
}

router.post('/report', agentAuth, (req, res) => {
  const m = validateReport(req.body);
  if (!m || m.cpu === null || m.mem_total === null) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  const ts = Date.now();
  // P1：先用服务端累加器按 month_rotate 口径覆盖 m.net_*_month，再落 metrics。
  db.accumulateTraffic(req.agent.id, m, ts);
  // F12：容量硬限时只停写历史明细 —— /report 仍 200、流量累加器/在线状态/告警
  // 全部照常，绝不因容量问题让节点被判定离线或告警失联。
  if (capacity.shouldWriteHistory()) {
    db.insertMetric(req.agent.id, Object.assign({ ts }, m));
  }
  // 受控端版本从 User-Agent 解析（diting-agent-go/1.0.9）；
  // 解析不到就传空，db 层用 COALESCE(NULLIF()) 保留库中已有值。
  const uaVer = (() => {
    const ua = String(req.header('User-Agent') || '');
    const hit = ua.match(/diting-agent(?:-go)?\/([0-9A-Za-z.\-+]+)/i);
    return hit ? hit[1] : '';
  })();
  db.touchAgent(req.agent.id, m.os, m.hostname, uaVer);
  // CPU 核数（§9 T18）：老 agent 不带该字段 → m.cores = 0 → 不写，库中保持 0 = 未知
  if (m.cores > 0) db.setAgentCores(req.agent.id, m.cores);
  // V.3 构建元信息（version/build_sha/build_time/platform）：老 agent 不带 agent_meta → 不写。
  // 仅变化才产生写事务（setAgentBuild 内部判定），稳态 20s 一次上报不额外写库。
  if (m.agent_meta) {
    db.setAgentBuild(req.agent.id, m.agent_meta.build_sha, m.agent_meta.build_time, m.agent_meta.platform);
  }
  maybeAutoRenew(req.agent);
  res.json({ ok: true });
});


// ---- Admin: overview ----
// 在原有「总数/在线/离线/平均 CPU/内存」基础上，补充「流量概览」与「分组概览」，
// 供前端对标社区主题的流量/地区概览区块直接渲染。
router.get('/overview', adminOrReadonly, agentScope, (req, res) => {
  // S2/F5：全局统计不向节点白名单 Token 开放。
  if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
  // 在线判定统一走 src/online.js（此前只看 env，概览的「在线数」会与列表绿点不一致）。
  // 局部计数变量改名 onlineCount：不能再叫 online，否则会遮蔽模块级的 online。
  const octx = online.buildCtx();
  const now = Date.now();
  const agents = db.getMonitoredAgents();
  let onlineCount = 0, cpuSum = 0, memSum = 0, cnt = 0;
  let trafficUsedBytes = 0; // 本月累计流量（在线节点 latest 的收+发）
  let totalQuotaGB = 0;
  const groups = {}; // 分组 -> { total, online }
  for (const a of agents) {
    const isOn = online.isOnline(a, now, octx);
    if (isOn) {
      onlineCount++;
      const m = db.getLatestMetric(a.id);
      if (m) { cpuSum += m.cpu || 0; memSum += m.mem_pct || 0; cnt++; trafficUsedBytes += (m.net_rx_month || 0) + (m.net_tx_month || 0); }
    }
    const g = (a.grp || '').trim() || '未分组';
    const ge = groups[g] || (groups[g] = { total: 0, online: 0 });
    ge.total++;
    if (isOn) ge.online++;
    totalQuotaGB += Number(a.monthly_quota_gb) || 0;
  }
  res.json({
    total: agents.length,
    online: onlineCount,
    offline: agents.length - onlineCount,
    avg_cpu: cnt ? +(cpuSum / cnt).toFixed(1) : 0,
    avg_mem: cnt ? +(memSum / cnt).toFixed(1) : 0,
    traffic_used_bytes: Math.round(trafficUsedBytes),
    total_quota_gb: totalQuotaGB,
    groups: Object.keys(groups).map(name => ({ name, total: groups[name].total, online: groups[name].online })),
    // 数据库大小监控：SQLite 文件实际占用的磁盘字节数（含 journal）
    db_size_bytes: db.getDbFileSize(),
    // 资产统计：先按币种分桶（不跨币种相加），再按设置里的手工汇率折算到标准货币。
    // 缺汇率的币种不计入总额，列在 billing.missing（见 src/billing.js convertSummary）。
    billing: convertSummary(summarizeByCurrency(agents, now), db.getUiSettings().billing)
  });
});

// ---- Admin: billing overview（月度费用 + 分组费用 + 7 天内到期列表）----
router.get('/billing', adminOrReadonly, agentScope, (req, res) => {
  // S2/F5：月度总费用/分组费用/到期列表均为全集群聚合，节点白名单 Token 不开放。
  if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
  const agents = db.getMonitoredAgents();
  const now = Date.now();
  const conv = convertSummary(summarizeByCurrency(agents, now), db.getUiSettings().billing);
  const perGroup = {};
  const expiringSoon = [];
  for (const a of agents) {
    const g = (a.grp || '').trim() || '未分组';
    const cur = normalizeCurrency(a.currency) || String(a.currency || 'CNY');
    const bucket = conv.by_currency[cur];
    const rate = bucket && bucket.rate ? bucket.rate : null;
    // 分组费用同样先折到标准货币再累加；缺汇率的节点不进总额（perGroup 保留 0 便于前端提示）
    if (!(g in perGroup)) perGroup[g] = 0;
    if (rate != null) perGroup[g] += (computeBilling(a, now).monthly_cost || 0) * rate;
    const daysLeft = daysUntil(a.expire_at);
    if (daysLeft !== null && daysLeft <= 7) {
      expiringSoon.push({ id: a.id, name: a.name, days_left: daysLeft });
    }
  }
  res.json({
    // 旧字段保留（前端/脚本可能仍在读）：monthly_total 现在已是折算到标准货币的值
    monthly_total: conv.monthly_cost,
    currency: conv.base_currency,
    base_currency: conv.base_currency,
    by_currency: conv.by_currency,
    missing: conv.missing,
    agent_count: agents.length,
    per_group: Object.keys(perGroup).map(name => ({ name, cost: +perGroup[name].toFixed(2) })),
    expiring_soon: expiringSoon.sort((a, b) => a.days_left - b.days_left)
  });
});


// ---- 游客视图域（/public/*）：routes/public.js ----
router.use(require('./routes/public'));

// ---- 主题管理（/admin/theme/*）：已拆分到 routes/admin-theme.js ----
router.use(require('./routes/admin-theme'));

// ---- Admin: 客户端 IP 诊断（配合 IP 白名单 / TRUST_PROXY 排障）----
// 返回服务端「看到的」客户端 IP 与当前 trust proxy 配置。管理员填 IP 白名单时，
// 若看到的不是自己的公网 IP（例如是 Nginx/容器的地址），说明需要在服务端设置
// TRUST_PROXY 声明可信反代，否则白名单与按 IP 限流都会按反代地址计算。
// 该路由自身有 adminOrReadonly 鉴权，故在 server.js 的 IP 白名单中间件里放行，
// 保证白名单配置错误把自己挡在门外时仍能自诊断。
router.get('/client-ip', adminOrReadonly, (req, res) => {
  const tp = req.app.get('trust proxy');
  res.json({
    ip: req.ip || '',
    // 默认值是函数（自定义 loopback 判定），直接序列化会变成 undefined，这里归一成 'loopback'
    trust_proxy: typeof tp === 'function' ? 'loopback' : tp,
    x_forwarded_for: req.header('X-Forwarded-For') || ''
  });
});

// ---- Admin: UI + 通知设置（持久化到 admin_config）----
// GET 返回当前设置；密码类字段脱敏（留空表示「保持不变」）。
// 备份策略校验：非法/越界值一律收敛到合法范围，避免写入脏数据后宿主侧脚本读不懂。
// 只做钳制不做报错——设置页保存是整体提交，因一个字段报错会打断其它设置。
function sanitizeBackupSettings(ui) {
  const schedules = ['off', 'daily', 'weekly'];
  if (ui.backup_schedule !== undefined && !schedules.includes(ui.backup_schedule)) {
    ui.backup_schedule = 'off';
  }
  if (ui.backup_hour !== undefined) {
    const h = Number(ui.backup_hour);
    ui.backup_hour = Number.isFinite(h) ? Math.min(23, Math.max(0, Math.trunc(h))) : 3;
  }
  if (ui.backup_keep_days !== undefined) {
    const d = Number(ui.backup_keep_days);
    // 0=不清理；上限 3650 天，防止误填天文数字
    ui.backup_keep_days = Number.isFinite(d) ? Math.min(3650, Math.max(0, Math.trunc(d))) : 14;
  }
  if (ui.backup_compress !== undefined) ui.backup_compress = !!ui.backup_compress;
}

// F12：容量保险丝阈值。行数/库字节（MiB）都做范围钳制，防止误填 0 或天文数字
// 导致「一启动就停写」或「永远不会触发」。
function sanitizeCapacitySettings(ui) {
  if (ui.capacity_enabled !== undefined) ui.capacity_enabled = !!ui.capacity_enabled;
  if (ui.capacity_max_rows !== undefined) {
    const n = Number(ui.capacity_max_rows);
    ui.capacity_max_rows = Number.isFinite(n) ? Math.min(100000000, Math.max(1000, Math.trunc(n))) : 2000000;
  }
  if (ui.capacity_max_mb !== undefined) {
    const n = Number(ui.capacity_max_mb);
    ui.capacity_max_mb = Number.isFinite(n) ? Math.min(16777216, Math.max(64, Math.trunc(n))) : 2048;
  }
}

// 资产汇率配置：只接受白名单币种键 + 有限正数汇率（钳到 1e-4 ~ 1e5，保留 4 位小数）。
// 非法项直接丢弃而不是整单 400 —— 与 capacity 的钳制口径一致，避免一个手误让整份设置保存失败。
// updated_at 只在汇率/标准币真正变化时刷新，避免每次保存设置都把「汇率时间」刷新掉。
function sanitizeBillingSettings(ui, prev) {
  if (!ui || !ui.billing || typeof ui.billing !== 'object') return;
  const b = ui.billing;
  // 标准币与汇率键统一存 ISO（前端可能提交符号，这里归一化）；未知币种直接丢弃
  const base = normalizeCurrency(b.base_currency) || 'CNY';
  const rates = {};
  const input = b.rates && typeof b.rates === 'object' ? b.rates : {};
  for (const [cur, raw] of Object.entries(input)) {
    const code = normalizeCurrency(cur);
    if (!code || code === base) continue;   // 基准币自身恒为 1，不存
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    rates[code] = Math.round(Math.min(1e5, Math.max(1e-4, n)) * 1e4) / 1e4;
  }
  // 旧设置可能是符号键，比较前也归一化，否则每次保存都会误判为「汇率变了」
  const prevBase = prev ? (normalizeCurrency(prev.base_currency) || '') : '';
  const prevRates = {};
  for (const [k, v] of Object.entries((prev && prev.rates) || {})) {
    const code = normalizeCurrency(k);
    if (code) prevRates[code] = Number(v);
  }
  const same = !!prev
    && prevBase === base
    && Object.keys(rates).length === Object.keys(prevRates).length
    && Object.keys(rates).every((k) => prevRates[k] === rates[k]);
  const prevTs = Number(prev && prev.updated_at);
  // 汇率来源：manual（默认）/ api；切回 manual 不做外呼
  const source = b.source === 'api' ? 'api' : 'manual';
  // API 快照只能由 src/fx.js 写：保存设置时从旧值继承，换标准币则整份作废
  const prevApi = prev && prev.api && typeof prev.api === 'object' ? prev.api : null;
  let api = prevApi
    ? { ...prevApi, rates: { ...(prevApi.rates || {}) } }
    : { provider: '', base, rates: {}, updated_at: 0, last_try_at: 0, status: 'never', error: '' };
  if (api.base !== base) {
    api = { provider: '', base, rates: {}, updated_at: 0, last_try_at: 0, status: 'never', error: '' };
  }
  ui.billing = {
    base_currency: base,
    rates,
    updated_at: same && Number.isFinite(prevTs) && prevTs > 0 ? Math.trunc(prevTs) : Date.now(),
    source,
    api,
  };
}


// ---- 备份 / 容量 / 恢复审查（/admin/backup*、/admin/capacity、/admin/restore-audit）----
// 已拆分到 routes/admin-billing.js。
router.use(require('./routes/admin-billing'));


// ---- 汇率自动刷新（可选；默认 manual = 零外呼）----
router.get('/fx/status', adminOrReadonly, (req, res) => {
  const billing = db.getUiSettings().billing || {};
  res.json({
    source: billing.source === 'api' ? 'api' : 'manual',
    base_currency: normalizeCurrency(billing.base_currency) || 'CNY',
    manual_updated_at: Number(billing.updated_at) || 0,
    api: billing.api || null,
  });
});

// 立即拉取一次（设置页「立即刷新」）；未启用 api 模式时 refresh 直接返回旧快照
router.post('/fx/refresh', adminOnly, agentScope, agentGlobalOnly, asyncHandler(async (req, res) => {
  const api = await require('./fx').refresh({ force: true });
  res.json({ ok: api.status === 'ok', api });
}));

router.get('/settings', adminOrReadonly, (req, res) => {
  const notify = db.getNotifyConfig();
  const safe = Object.assign({}, notify);
  if (safe.smtp_pass) safe.smtp_pass = '';
  if (safe.telegram_bot_token) safe.telegram_bot_token = '';
  res.json({ ui: db.getUiSettings(), notify: safe });
});
router.put('/settings', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const b = req.body || {};
  // 写库前取旧值快照，供审计记录变更字段名（体检 L-4）
  const uiBefore = db.getUiSettings();
  const notifyBefore = db.getNotifyConfig();
  if (b.ui && typeof b.ui === 'object') {
    // M-1：自定义 CSS 在落库前清洗，杜绝 @import/url()/外链字体/脚本注入。
    if (typeof b.ui.custom_css === 'string') b.ui.custom_css = sanitizeCss(b.ui.custom_css);
    sanitizeBackupSettings(b.ui);
    sanitizeCapacitySettings(b.ui);
    sanitizeBillingSettings(b.ui, uiBefore.billing);
    // setUiSettings 是整体覆盖写：仪表盘布局由专用接口 PUT /admin/dashboard/layout 管理，
    // 设置表单未携带该字段时沿用旧值，避免在设置页保存后把布局清空。
    if (!Object.prototype.hasOwnProperty.call(b.ui, 'admin_dashboard_layout')) {
      b.ui.admin_dashboard_layout = uiBefore.admin_dashboard_layout ?? null;
    }
    db.setUiSettings(b.ui);
  }
  if (b.notify && typeof b.notify === 'object') db.setNotifyConfig(b.notify);
  res.json({ ok: true });
  // 保留原有标签拼接，追加变更字段名（敏感键已打码）
  const tags = (b.ui ? 'ui updated ' : '') + (b.notify ? 'notify updated ' : '');
  const changed = [];
  if (b.ui) changed.push(`ui:${diffKeys(uiBefore, db.getUiSettings())}`);
  if (b.notify) changed.push(`notify:${diffKeys(notifyBefore, db.getNotifyConfig())}`);
  auditLog(req, 'update_settings', (tags + changed.join(' ')).trim());
});

// 后台仪表盘布局（对齐参考面板）：只写 ui.admin_dashboard_layout 一个字段。
// 独立接口而非复用 PUT /settings——后者是整体覆盖写库，若前端只带布局会把其他设置抹掉。
router.put('/admin/dashboard/layout', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const v = validators.validateDashboardLayout(req.body && req.body.layout);
  if (!v.ok) return res.status(400).json({ error: v.error });
  db.setUiSettings(Object.assign({}, db.getUiSettings(), { admin_dashboard_layout: v.value }));
  auditLog(req, 'update_dashboard_layout',
    `cards=${v.value.map((w) => `${w.id}:${w.width}/${w.height}`).join(',')}`);
  res.json({ ok: true, layout: v.value });
});



// ---- 通知渠道 / 通知组（/admin/notify/*）：已拆分到 routes/admin-notify.js ----
router.use(require('./routes/admin-notify'));

// ---- Admin: send a test alert through all matching channels ----
router.post('/test-alert', adminOnly, agentScope, agentGlobalOnly, asyncHandler(async (req, res) => {
  const st = alerts.notifyStatus();
  if (!st.mail && !st.telegram && !st.webhook) {
    return res.status(400).json({ error: '未配置任何启用的通知通道（邮件 / Telegram / Webhook）', status: st });
  }
  try {
    const ok = await alerts.sendAlert('[监控] 测试告警', '这是一条测试消息，用于验证通知通道（邮件 / Telegram / Webhook）是否配置正确。若你收到了，说明配置生效。', 'test');
    if (!ok) {
      return res.status(502).json({ error: 'send_failed', message: '测试告警投递失败，请检查服务端日志与通知配置', status: st });
    }
    res.json({ ok: true, message: '测试告警已发送，请检查各通知渠道。', status: st });
  } catch (e) {
    // 审查 G6：细节（SMTP 错误串，可能含主机名/凭据片段）只落日志，不回显客户端
    console.error('[test-alert] 发送失败:', e.message);
    res.status(500).json({ error: 'send_failed', message: '测试告警发送失败，请检查服务端日志与通知配置', status: st });
  }
}));

// ---- Admin: AI 运维分析 ----
// 配置读写、手动触发、报告列表/详情、运行状态。全部受 admin 鉴权保护。
// ai 模块默认关闭（getAiConfig().enabled === false），不影响现有功能。
const ai = require('./ai');
// GET 配置：api_key 脱敏（留空表示「已配置但本次不回显」，同 smtp_pass 处理，api.js:520）
router.get('/ai/config', adminOrReadonly, (req, res) => {
  const c = db.getAiConfig();
  const safe = Object.assign({}, c);
  if (safe.api_key) safe.api_key = '';
  // 补充一个 has_key 标志，让前端知道密钥是否已配置（不泄露密钥本身）；
  // AI_KEY_FROM_ENV=1 时以环境变量为准，DB 中的 Key 不参与。
  const fromEnv = process.env.AI_KEY_FROM_ENV === '1';
  safe.has_key = fromEnv ? !!process.env.AI_API_KEY : !!c.api_key;
  safe.key_from_env = fromEnv;
  res.json({ config: safe });
});
// PUT 配置：api_key 留空保持不变（同 setNotifyConfig 模式，db.js setAiConfig 内部处理）
router.put('/ai/config', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const b = (req.body && req.body.config) || {};
  const allowed = {};
  // 白名单字段，避免前端塞入未预期字段
  if (typeof b.enabled === 'boolean') allowed.enabled = b.enabled;
  if (typeof b.provider === 'string') allowed.provider = b.provider.slice(0, 40);
  if (typeof b.base_url === 'string') allowed.base_url = b.base_url.slice(0, 200);
  if (typeof b.model === 'string') allowed.model = b.model.slice(0, 80);
  // AI_KEY_FROM_ENV=1 时密钥只来自环境变量：入口直接拒绝写入，避免"保存成功但没存"的误解。
  // db.setAiConfig 还有第二层剔除，防止非 HTTP 调用方绕过。
  if (typeof b.api_key === 'string' && process.env.AI_KEY_FROM_ENV !== '1') allowed.api_key = b.api_key.slice(0, 200);
  if (typeof b.schedule_freq === 'string' && ['daily', 'weekly', 'every6h', 'every12h'].includes(b.schedule_freq)) allowed.schedule_freq = b.schedule_freq;
  if (typeof b.schedule_time === 'string' && /^\d{1,2}:\d{2}$/.test(b.schedule_time)) allowed.schedule_time = b.schedule_time;
  if (typeof b.tz_offset_hours === 'number' && Number.isFinite(b.tz_offset_hours)) allowed.tz_offset_hours = Math.max(-12, Math.min(14, b.tz_offset_hours));
  if (typeof b.locale === 'string' && ['zh-CN', 'en'].includes(b.locale)) allowed.locale = b.locale;
  if (typeof b.log_retention_days === 'number' && Number.isFinite(b.log_retention_days)) allowed.log_retention_days = Math.max(7, Math.min(3650, Math.floor(b.log_retention_days)));
  if (typeof b.silent_days === 'number' && Number.isFinite(b.silent_days)) allowed.silent_days = Math.max(0, Math.min(90, Math.floor(b.silent_days)));
  // 单节点分析缓存 TTL（分钟）：下限 30（成本护栏，不允许更小）、上限 1440
  if (typeof b.node_cache_ttl_minutes === 'number' && Number.isFinite(b.node_cache_ttl_minutes)) allowed.node_cache_ttl_minutes = Math.max(30, Math.min(1440, Math.floor(b.node_cache_ttl_minutes)));
  // 启用时校验：必须有 model；api_key 要么本次传入非空，要么之前已配置
  if (allowed.enabled) {
    // AI_KEY_FROM_ENV=1 时以环境变量为准，DB 中的 Key 不参与校验
    const fromEnv = process.env.AI_KEY_FROM_ENV === '1';
    const hasKey = fromEnv ? !!process.env.AI_API_KEY : (!!allowed.api_key || !!db.getAiConfig().api_key);
    const hasModel = !!allowed.model || !!db.getAiConfig().model;
    if (!hasModel) return res.status(400).json({ error: '启用 AI 分析需先配置模型名称（model）' });
    if (!hasKey) return res.status(400).json({ error: '启用 AI 分析需先配置 API Key' });
  }
  const aiBefore = db.getAiConfig();
  db.setAiConfig(allowed);
  res.json({ ok: true });
  // 记录变更字段名（api_key 等敏感键打码为 k=*），并保留 enabled 显式标签
  const enabledTag = allowed.enabled != null ? `enabled=${allowed.enabled} ` : '';
  auditLog(req, 'update_ai_config', (enabledTag + `fields=${diffKeys(aiBefore, db.getAiConfig())}`).trim());
});
// ---- 受控端自助注册令牌（SETUP_TOKEN）：库为权威，管理面可直接维护 ----
// 不回显明文：GET 只报"是否已配置 + 来源"；生成/设置时**一次性**回显明文
// （与安装向导 Token 同口径，库里不存可逆形式之外的副本）。
router.get('/setup-token', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const { token, source } = resolveSetupToken();
  res.json({ configured: !!token, source, weak: !!token && isWeakSetupToken(token) });
});

// action=generate｜set｜clear。generate 用 crypto 随机 16 字节（32 hex）；
// set 需传 token（≥16 且不能过弱）；clear 删除库中令牌并阻止 env 残留回灌。
router.post('/setup-token', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const action = (req.body && req.body.action) || '';
  if (action === 'clear') {
    db.clearSetupToken();
    db.markSetupTokenCleared();
    auditLog(req, 'update_setup_token', 'cleared');
    return res.json({ ok: true, configured: false });
  }
  let token;
  if (action === 'generate') {
    // 随机十六进制有极小概率落入"含连续序列"的弱模式（如 0123），重抽直到够强
    do { token = crypto.randomBytes(16).toString('hex'); } while (isWeakSetupToken(token));
  } else if (action === 'set') {
    token = String((req.body && req.body.token) || '').trim();
    if (token.length < 16) return res.status(400).json({ error: '令牌长度至少 16 位' });
  } else {
    return res.status(400).json({ error: 'action 需为 generate / set / clear' });
  }
  if (isWeakSetupToken(token)) {
    return res.status(400).json({ error: 'SETUP_TOKEN 过弱（禁用纯数字/极少字符种类/连续序列，建议 openssl rand -hex 16）' });
  }
  db.unmarkSetupTokenCleared();
  db.setSetupToken(token);
  auditLog(req, 'update_setup_token', action === 'generate' ? 'generated' : 'set');
  res.json({ ok: true, configured: true, token });   // 明文仅此一次
});
// 手动触发一次日报生成（不等调度时刻）：【异步任务】—— 立即返回，任务在后台跑。
// 状态码：202 已受理 / 400 未启用 / 409 已有任务在执行 / 429 冷却中（带 Retry-After）。
// 之所以不阻塞等待：单次生成最长 180s（推理模型），同步等待会被反代按默认 60s 超时截断成 504，
// 而服务端仍会跑完并发报，用户以为失败会重复点击 → 重复计费。
router.post('/ai/run', adminOnly, agentScope, agentGlobalOnly, asyncHandler(async (req, res) => {
  const force = req.query.force === '1';
  try {
    const r = await ai.triggerRun({ force });
    auditLog(req, 'ai_run', `status=${r.status}${force ? ' force=1' : ''}`);
    if (r.status === 'disabled') return res.status(400).json(r);
    if (r.status === 'busy') return res.status(409).json(r);
    if (r.status === 'cooldown') {
      res.set('Retry-After', String(r.retry_after_s));
      // message 保持中文（与 API 层其余错误文案一致）；本地化由前端用 retry_after_s 渲染
      return res.status(429).json(Object.assign({}, r, { message: `冷却中，请 ${r.retry_after_s} 秒后再试` }));
    }
    return res.status(202).json(r);
  } catch (e) {
    auditLog(req, 'ai_run', `status=error ${e.message}`);
    throw e;
  }
}));
// 单节点按需分析（T11）：同一节点+同一窗口的结果缓存 30 分钟，避免重复点击重复计费。
// ?hours= 窗口可选：24（默认）/ 168（7 天）/ 720（30 天），clamp 到 24–720（与 ai/index.js 同界）。
router.post('/ai/analyze-node/:id', adminOnly, agentScope, asyncHandler(async (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const periodHours = Math.max(24, Math.min(720, Math.round(Number(req.query.hours)) || 24));
  const r = await ai.analyzeNode(String(req.params.id), { periodHours });
  auditLog(req, 'ai_analyze_node', `agent=${req.params.id} status=${r.status} hours=${periodHours}`);
  if (r.status === 'not_found') return res.status(404).json(r);
  if (r.status === 'disabled') return res.status(400).json(r);
  // 审查 G6：AI 分析失败的底层错误（可能含服务商 URL/密钥片段）只落日志，
  // 不回显客户端；r.message 由 ai/index.js 的 catch 分支产生。
  if (r.status === 'error') {
    console.error('[ai/analyze-node] 分析失败:', r.message);
    return res.status(502).json({ status: 'error', error: 'analysis_failed', message: '分析失败，请检查服务端日志与 AI 配置' });
  }
  return res.json(r);
}));

// AI 用量趋势（近 N 天按 UTC 日聚合 token 消耗）。默认 7 天，clamp 1–90。
// 老报告的 token 列为 0（加列前的数据），不影响聚合正确性。
router.get('/ai/usage', adminOrReadonly, agentScope, (req, res) => {
  // S2/F5：AI 用量为全集群聚合，节点白名单 Token 不开放。
  if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
  const rows = db.aiUsageDaily(Date.now() - days * 86400000);
  const list = rows.map((r) => ({
    day: new Date(Number(r.day) * 86400000).toISOString().slice(0, 10),
    reports: Number(r.reports) || 0,
    prompt_tokens: Number(r.prompt_tokens) || 0,
    completion_tokens: Number(r.completion_tokens) || 0,
    total_tokens: Number(r.total_tokens) || 0
  }));
  res.json({ days, total_tokens: list.reduce((s, x) => s + x.total_tokens, 0), list });
});

// 单节点分析历史（§8 T17）：?agent_id=&limit=1..50（默认 10）。
// 列表刻意不含 report_json（单条可达数十 KB），只给渲染历史条目所需字段。
router.get('/ai/node-reports', adminOrReadonly, agentScope, (req, res) => {
  const agentId = String(req.query.agent_id || '').trim();
  if (!agentId) return res.status(400).json({ error: 'agent_id required' });
  if (!inAgentScope(req, agentId)) return res.status(403).json({ error: 'forbidden_node' });
  if (!db.getAgent(agentId)) return res.status(404).json({ error: 'agent not found' });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  res.json({ agent_id: agentId, limit, list: db.listAiNodeReports(agentId, limit) });
});

// 运行状态（前端展示 last_run / last_status）
router.get('/ai/status', adminOrReadonly, (req, res) => {
  res.json(ai.getStatus());
});
// 报告列表（分页）
router.get('/ai/reports', adminOrReadonly, agentScope, (req, res) => {
  // S2/F5：报告可能涵盖其他节点数据，节点白名单 Token 不开放。
  if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const list = db.listAiReports(limit, offset);
  res.json({ total: db.countAiReports(), limit, offset, list });
});
// 单条报告详情（含 report_json，供前端渲染完整分析）
router.get('/ai/reports/:id', adminOrReadonly, agentScope, (req, res) => {
  // S2/F5：单份报告含 report_json（可能覆盖其他节点），节点白名单 Token 不开放。
  if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const r = db.getAiReport(id);
  if (!r) return res.status(404).json({ error: 'not found' });
  let parsed = null;
  try { parsed = JSON.parse(r.report_json); } catch (e) {}
  res.json(Object.assign({}, r, { report_json_parsed: parsed }));
});



// ---- 受控端管理（版本可判定性 / 告警规则 / artifact / 分发）：routes/admin-agent.js ----
router.use(require('./routes/admin-agent'));

// ---- 安全域（API Token / 会话 / 2FA / 审计日志）：已拆分到 routes/admin-security.js ----
router.use(require('./routes/admin-security'));

module.exports = router;
// 供单测直接断言（router 本身不便测纯函数）：体检 L-4
module.exports.diffKeys = diffKeys;
// 供单测断言「命令生成」这类纯函数（含防换行注入的关键约束）
module.exports.buildModifyCommands = buildModifyCommands;
module.exports.buildInstallCommands = buildInstallCommands;
