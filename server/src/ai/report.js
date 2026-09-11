// report.js —— 日报生成与渲染
//
// 职责：把 summarizer 的统计摘要 + provider 的 AI 分析结果，渲染成可发送的日报文本。
// 调用 alerts.sendAlert(subject, text)（alerts.js:55）投递，邮件走纯文本、Telegram 走 HTML。
//
// 【降级路径】（核心设计）：
//   summarizer 是纯本地计算，永不失败，是降级基底。
//   - LLM 成功：日报 = 统计概览 + AI 分析（标注「AI 生成，仅供参考」）。
//   - LLM 失败（超时/限流/密钥错）：日报仍发送，但退化为【纯统计版】+「AI 分析本次失败：<原因>」。
//     绝不静默吞掉——这与 alerts.js 的 try/catch 吞错模式一致，但更显式地告知用户失败原因。
//
// 【幻觉防护】：日报属于非紧急、可复核场景，AI 自由文本只在这里出现。
// 实时告警（V1.5）【绝不】附 AI 自由文本，只附静态统计摘要。

const db = require('../db');
const { summarize } = require('./summarizer');
const { analyze, parseAnalysis, AiError } = require('./provider');
const { clampRisk } = require('./stats');
const { PROMPT_VERSION } = require('./prompt');
const alerts = require('../alerts');

// ---- 轻量中英双语翻译表（仅覆盖通知正文，不做全页面 i18n） ----
const I18N = {
  'zh-CN': {
    stats_header: (n, on, off) => `节点总数：${n}（在线 ${on}，离线 ${off}）`,
    stats_period: (p) => `统计周期：过去 ${p}`,
    all_normal: '所有节点指标正常，无重点关注项。',
    flagged_header: '需关注节点：',
    offline: (name) => `[${name}] 离线`,
    node_label: (name) => `[${name}]`,
    cpu_line: (avg, max, min) => `  CPU：均值 ${avg} / 峰值 ${max} / 超90% ${min}分钟`,
    mem_line: (avg, max, slope) => `  内存：均值 ${avg} / 峰值 ${max}${slope != null ? ` / 周期内变化 ${slope >= 0 ? '+' : ''}${slope}个百分点` : ''}`,
    disk_current: (v) => `  磁盘：当前 ${v}（近 24h 中位）`,
    disk_forecast: (days, lo, hi, win, conf) => ` / 按近 ${win} 天趋势综合估计约 ${days} 天达 90%（${lo}–${hi} 天，置信度${conf}）`,
    disk_forecast_fast: (days, fast, win) => ` / 按近 ${win} 天趋势综合估计约 ${days} 天达 90%（最快 ${fast} 天；存在回落，可能更久）`,
    disk_no_trend: (win) => ` / 近 ${win} 天无增长趋势`,
    disk_insufficient: ' / 趋势数据不足，暂不预测',
    conf_low: '低',
    conf_medium: '中',
    conf_high: '高',
    ai_section: '———— AI 运维分析（仅供参考）————',
    risk_level: (v) => `整体风险：${v}`,
    issue: (v) => `  问题：${v}`,
    reason: (v) => `  可能原因：${v}`,
    suggestion: (v) => `  排查方向：${v}`,
    node_prefix: (v) => `【${v}】`,
    ai_parse_fail: '（AI 返回内容无法解析为结构化结果，已忽略）',
    degraded_section: '———— AI 运维分析 ————',
    degraded_body: (err) => `本次 AI 分析失败，已降级为纯统计版。失败原因：${err}`,
    degraded_hint: '可在「系统设置 → AI 运维分析」检查配置，或稍后手动重试。',
    expire_upcoming: (date, days) => `  到期：${date}（剩 ${days} 天）`,
    expire_overdue: (days) => `  到期：已过期 ${Math.abs(days)} 天`,
    expire_free: (cycle) => `  ${cycle}节点（无到期日）`,
    expire_no_date: (cycle) => `  ${cycle}节点（未设到期日）`,
  },
  en: {
    stats_header: (n, on, off) => `Agents: ${n} total (${on} online, ${off} offline)`,
    stats_period: (p) => `Period: past ${p}`,
    all_normal: 'All agents normal, no issues flagged.',
    flagged_header: 'Flagged agents:',
    offline: (name) => `[${name}] offline`,
    node_label: (name) => `[${name}]`,
    cpu_line: (avg, max, min) => `  CPU: avg ${avg} / peak ${max} / over90% ${min}min`,
    mem_line: (avg, max, slope) => `  Memory: avg ${avg} / peak ${max}${slope != null ? ` / period delta ${slope >= 0 ? '+' : ''}${slope}pp` : ''}`,
    disk_current: (v) => `  Disk: ${v} (24h median)`,
    disk_forecast: (days, lo, hi, win, conf) => ` / ~${days} days to 90% by the ${win}-day trend estimate (${lo}–${hi} days, ${conf} confidence)`,
    disk_forecast_fast: (days, fast, win) => ` / ~${days} days to 90% by the ${win}-day trend estimate (fastest ${fast} days; recent dip, could be longer)`,
    disk_no_trend: (win) => ` / no growth trend over the last ${win} days`,
    disk_insufficient: ' / not enough trend data to forecast',
    conf_low: 'low',
    conf_medium: 'medium',
    conf_high: 'high',
    ai_section: '———— AI Ops Analysis (for reference) ————',
    risk_level: (v) => `Risk level: ${v}`,
    issue: (v) => `  Issue: ${v}`,
    reason: (v) => `  Possible reason: ${v}`,
    suggestion: (v) => `  Suggestion: ${v}`,
    node_prefix: (v) => `【${v}】`,
    ai_parse_fail: '(AI response could not be parsed as structured JSON; ignored)',
    degraded_section: '———— AI Ops Analysis ————',
    degraded_body: (err) => `AI analysis failed; degraded to stats-only. Reason: ${err}`,
    degraded_hint: 'Check config in Settings → AI Ops Analysis, or retry manually later.',
    expire_upcoming: (date, days) => `  Expires: ${date} (${days}d left)`,
    expire_overdue: (days) => `  Expired ${Math.abs(days)}d ago`,
    expire_free: (cycle) => `  ${cycle} tier (no expiry)`,
    expire_no_date: (cycle) => `  ${cycle} tier (no expiry date set)`,
  },
};
function t(key, locale, ...args) {
  const lang = I18N[locale] || I18N['zh-CN'];
  const fn = lang[key] || I18N['zh-CN'][key];
  return typeof fn === 'function' ? fn(...args) : (fn || key);
}

// 格式化百分比，null 显示「-」。
function pct(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(1) + '%' : '-';
}

// 渲染单个节点的计费/到期信息行（若有）。纯文本，双语。
// 逻辑：白嫖(cycle=0) 不显示到期；无 expire_at 显示「未设到期日」；
// 已过期显示「已过期 N 天」；否则「剩 N 天」。
function renderExpireSection(s, locale) {
  const b = s.billing;
  if (!b) return '';
  const cycle = b.cycle_label || '';
  if (b.billing_cycle === 0) return t('expire_free', locale, cycle);
  // expire_at 为空时不要打印「undefined/null（剩 N 天）」：只设了周期未填到期日属常见情形
  if (b.days_until_expire == null || !b.expire_at) return t('expire_no_date', locale, cycle);
  if (b.days_until_expire < 0) return t('expire_overdue', locale, b.days_until_expire);
  return t('expire_upcoming', locale, b.expire_at, b.days_until_expire);
}

// 渲染【统计版】正文（纯文本，用于邮件 & 作为降级基底）。
function renderStatsText(summary, locale) {
  const lines = [];
  lines.push(t('stats_header', locale, summary.agent_count, summary.online_count, summary.offline_count));
  lines.push(t('stats_period', locale, summary.period));
  lines.push('');
  // 只列出有状况的节点（CPU/内存/磁盘偏高、离线、或临期/已过期），避免日报过长。
  const flagged = summary.agents.filter(s => {
    if (!s.online) return true;
    if (s.cpu && (s.cpu.avg >= 70 || (s.cpu.max || 0) >= 90)) return true;
    if (s.memory && (s.memory.avg >= 70 || (s.memory.max || 0) >= 90)) return true;
    if (s.disk && (s.disk.current_pct || 0) >= 80) return true;
    // 临期(<=7天)或已过期也纳入关注，避免续费风险被忽略。
    if (s.billing && s.billing.days_until_expire != null && s.billing.days_until_expire <= 7) return true;
    return false;
  });

  if (!flagged.length) {
    lines.push(t('all_normal', locale));
    return lines.join('\n');
  }

  lines.push(t('flagged_header', locale));
  for (const s of flagged) {
    lines.push('');
    if (!s.online) { lines.push(t('offline', locale, s.name)); continue; }
    lines.push(t('node_label', locale, s.name));
    if (s.cpu && s.cpu.avg != null) lines.push(t('cpu_line', locale, pct(s.cpu.avg), pct(s.cpu.max), s.cpu.over_threshold_minutes));
    if (s.memory && s.memory.avg != null) {
      const slope = s.memory.slope_pct;
      lines.push(t('mem_line', locale, pct(s.memory.avg), pct(s.memory.max), slope));
    }
    if (s.disk && s.disk.current_pct != null) lines.push(renderDiskLine(s.disk, locale));
    const expireLine = renderExpireSection(s, locale);
    if (expireLine) lines.push(expireLine);
  }
  return lines.join('\n');
}

// 渲染【完整版】正文（统计 + AI 分析）。
function renderFullText(summary, analysis, locale) {
  const lines = [];
  lines.push(renderStatsText(summary, locale));
  lines.push('');
  lines.push(t('ai_section', locale));
  if (analysis) {
    if (analysis.risk_level) lines.push(t('risk_level', locale, analysis.risk_level));
    if (analysis.summary) lines.push(analysis.summary); // AI 返回的总结按模型输出语言，不强转
    if (Array.isArray(analysis.highlights) && analysis.highlights.length) {
      lines.push('');
      for (const h of analysis.highlights) {
        lines.push(t('node_prefix', locale, h.agent_name || '-'));
        if (h.issue) lines.push(t('issue', locale, h.issue));
        if (h.reason) lines.push(t('reason', locale, h.reason));
        if (h.suggestion) lines.push(t('suggestion', locale, h.suggestion));
      }
    }
  } else {
    lines.push(t('ai_parse_fail', locale));
  }
  return lines.join('\n');
}

// 渲染【降级版】正文（统计 + 失败原因）。
function renderDegradedText(summary, errMsg, locale) {
  const lines = [];
  lines.push(renderStatsText(summary, locale));
  lines.push('');
  lines.push(t('degraded_section', locale));
  lines.push(t('degraded_body', locale, errMsg));
  lines.push(t('degraded_hint', locale));
  return lines.join('\n');
}

// ---- 磁盘行渲染（统计正文用）----
// 与 prompt 的「引用数字必须带区间/不确定性」规则保持一致：若统计段给裸数字、AI 段给区间，
// 同一份报告里两种口径会互相打架。
function renderDiskLine(disk, locale) {
  const head = t('disk_current', locale, pct(disk.current_pct));
  const note = disk.trend_note;
  const win = disk.trend_window_days || 7;
  if (note === 'insufficient') return head + t('disk_insufficient', locale);
  if (note === 'no_growth') return head + t('disk_no_trend', locale, win);
  const days = disk.estimated_full_days;
  if (typeof days !== 'number' || days <= 0) return head;
  const rng = Array.isArray(disk.estimated_full_days_range) ? disk.estimated_full_days_range : [];
  const lo = Number.isFinite(rng[0]) ? rng[0] : null;
  const hi = Number.isFinite(rng[1]) ? rng[1] : null;
  if (hi == null) return head + t('disk_forecast_fast', locale, days, lo == null ? days : lo, win);
  const conf = disk.trend_confidence === 'medium' ? t('conf_medium', locale)
    : (disk.trend_confidence === 'high' ? t('conf_high', locale) : t('conf_low', locale));
  return head + t('disk_forecast', locale, days, lo, hi, win, conf);
}

// ---- highlights 后处理：上限 + 幻觉过滤 + 离线聚合 ----
// 职责边界：prompt 只负责「≤8 条、按严重度排序、agent_name 必须逐字取自摘要」，
// 聚合 100% 由这里生成 —— 若让模型自造聚合名（如「多节点」），会被下面的白名单当幻觉删掉，
// 聚合逻辑将永不触发（第一轮审计的 P0-2）。
function capHighlights(analysis, summary, opts) {
  const max = (opts && Number(opts.max)) || 8;
  // 模型可能返回数组/标量：非普通对象一律原样透传（renderFullText 会走「无法解析」分支）
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return { analysis, stats: null };

  const list = Array.isArray(analysis.highlights) ? analysis.highlights.slice() : [];
  const agents = Array.isArray(summary && summary.agents) ? summary.agents : [];
  const names = new Set(agents.map((a) => a.name));
  const offline = new Set(agents.filter((a) => !a.online).map((a) => a.name));

  const clean = list.filter((h) => h && typeof h === 'object' && names.has(h.agent_name));
  const droppedUnknown = list.length - clean.length;
  // 沉默期（长期未上报）节点：不再逐台写进日报，只并入离线聚合条目里提一句（T9）
  const stale = new Set(agents.filter((a) => a.stale).map((a) => a.name));
  const staleHits = clean.filter((h) => stale.has(h.agent_name));
  const rest = clean.filter((h) => !stale.has(h.agent_name));
  const offlineHits = rest.filter((h) => offline.has(h.agent_name));
  const onlineHits = rest.filter((h) => !offline.has(h.agent_name));

  const out = [];
  // 只要离线节点达到 3 台就必须有一条聚合条目（由本函数生成，不依赖模型是否逐台列出）：
  // 实测模型有时会自行聚合成「mock-000 ~ mock-059 等 61 台节点」这类非真实节点名，
  // 该条目会被上面的白名单当幻觉丢弃 —— 若此时要求 offlineHits>=2 才聚合，
  // 离线信息就会从报告里彻底消失（真机报告 #54 复现过）。
  if (offline.size >= 3) {
    const sample = Array.from(offline).slice(0, 5).join('、');
    const silentDays = Number(summary && summary.silent_days) || 3;
    out.push({
      agent_name: '(多节点)',
      issue: `${offline.size} 台节点离线（${sample}${offline.size > 5 ? ' 等' : ''}）`
        + (staleHits.length ? `，其中 ${staleHits.length} 台超过 ${silentDays} 天未上报` : ''),
      reason: '可能是区域性网络中断、批量到期停机或探针未部署（概率性判断）',
      suggestion: '按分组/地域核对离线集合，优先确认是否共用同一网络出口或服务商'
    });
  } else {
    out.push(...offlineHits);
  }
  out.push(...onlineHits);

  const trimmed = out.slice(0, max);
  if (out.length > max) {
    trimmed.push({
      agent_name: '(其他)',
      issue: `另有 ${out.length - max} 个关注项未逐条列出`,
      reason: '',
      suggestion: '详见报告正文的统计部分'
    });
  }

  // 长度卫生：模型可能把字段回成数字/对象，直接进邮件或 Telegram 会显示 [object Object]
  const clip = (v, n) => (v == null ? '' : (typeof v === 'string' ? v : String(v)).slice(0, n));
  const safe = trimmed.map((h) => ({
    agent_name: clip(h.agent_name, 50),
    issue: clip(h.issue, 200),
    reason: clip(h.reason, 300),
    suggestion: clip(h.suggestion, 300)
  }));

  return {
    analysis: Object.assign({}, analysis, { highlights: safe }),
    stats: {
      raw: list.length,
      kept: safe.length,
      dropped_unknown: droppedUnknown,
      offline_total: offline.size,
      stale_dropped: staleHits.length
    }
  };
}

// 主入口：生成并落库一份日报，然后发送通知。
//   opts.trigger: 'schedule' | 'manual'（用于日志/状态区分）
// 返回 { status: 'ok'|'degraded'|'disabled'|'error', report_id?, message }
async function generateAndSend(opts) {
  const trigger = (opts && opts.trigger) || 'manual';
  const config = db.getAiConfig();

  if (!config.enabled) {
    return { status: 'disabled', message: 'AI 分析未启用' };
  }

  // 通知通道检查（与 /api/test-alert 同款，api.js:537-548）：无通道则不发，但仍落库报告。
  const channels = alerts.notifyStatus();
  const hasChannel = channels.mail || channels.telegram;

  const t0 = Date.now();   // 单次生成耗时起点（含 LLM 调用 + 投递），结果写 ai_state.last_duration_ms

  // ① 始终先做本地统计（降级基底）
  const summary = summarize({ periodHours: Number(config.period_hours) || 24 });

  let analysis = null;
  let aiText = '';        // 模型原始返回文本，落库用
  let aiUsage = null;     // 模型返回的 token 用量（此前被丢弃 → 无成本可见性）
  let degradeReason = '';
  let degraded = false;

  // ② 尝试调用模型
  try {
    const result = await analyze(config, summary);
    aiText = result.text;
    aiUsage = result.usage || null;
    analysis = parseAnalysis(result.text);
    if (!analysis) {
      // 文本不是合法 JSON：不算硬失败（模型还是回了），降级为「无法解析」
      degraded = false; // 走 full 路径，renderFullText 会标注无法解析
    }
  } catch (e) {
    degraded = true;
    degradeReason = e.message || String(e);
    console.error('[ai] provider 调用失败（降级为统计版）：', degradeReason);
  }

  // ③ 落库（无论成败都存一份，便于回溯）
  //   先做 highlights 后处理并【回写 analysis】：上限裁剪 + 幻觉节点名过滤 + 离线聚合。
  //   必须早于下面的 risk_level/summary/suggestion 取值——否则 suggestion 仍按原始 60+ 条拼，
  //   且 report_json 仍会是 35~44KB 的节点清单。
  const capped = capHighlights(analysis, summary);
  analysis = capped.analysis;

  // 风险等级锚定本地确定性规则：偏离 summary.baseline_risk 超过一级即校正（见 stats.clampRisk），
  // 并保留模型原始判定，便于回看它是否长期被少数节点带偏（「风险通胀」）。
  if (analysis) {
    const rawRisk = String(analysis.risk_level || '').toLowerCase();
    const clamped = clampRisk(rawRisk, summary.baseline_risk);
    analysis = Object.assign({}, analysis, {
      risk_level: clamped,
      risk_level_raw: rawRisk,
      risk_clamped: clamped !== rawRisk
    });
  }

  const riskLevel = analysis ? (analysis.risk_level || '') : '';
  const aiSummary = analysis ? (analysis.summary || '') : '';
  const suggestion = analysis
    ? (Array.isArray(analysis.highlights) ? analysis.highlights.map(h => `[${h.agent_name||'-'}] ${h.suggestion||''}`).join('\n') : '')
    : (degraded ? 'AI 分析失败：' + degradeReason : '');
  const usage = (aiUsage && typeof aiUsage === 'object') ? aiUsage : {};
  const reportJson = JSON.stringify({
    summary,
    analysis: analysis || { _parse_error: true, raw: aiText.slice(0, 2000) },
    highlight_stats: capped.stats || null,
    // 本地确定性锚点与信号量：便于回溯「模型原始等级 vs 本地规则」的偏差
    baseline_risk: summary.baseline_risk,
    signals: summary.signals,
    degraded,
    degrade_reason: degradeReason
  });

  const report = db.insertAiReport({
    period: summary.period,
    risk_level: riskLevel,
    summary: aiSummary,
    suggestion,
    report_json: reportJson,
    prompt_version: PROMPT_VERSION,
    prompt_tokens: Number(usage.prompt_tokens) || 0,
    completion_tokens: Number(usage.completion_tokens) || 0,
    total_tokens: Number(usage.total_tokens) || 0,
    duration_ms: Date.now() - t0,
    // 与 report_json.degraded 同源赋值，避免两处漂移
    degraded: degraded ? 1 : 0
  });

  // ④ 渲染并投递
  const locale = config.locale || 'zh-CN';
  const tz = (config.tz_offset_hours != null ? config.tz_offset_hours : 8) * 3600000;
  const dateStr = new Date(Date.now() + tz).toLocaleDateString(locale === 'en' ? 'en-US' : 'zh-CN', { timeZone: 'UTC' });
  const subject = locale === 'en' ? `[diting AI Report] ${dateStr}` : `[diting 运维日报] ${dateStr}`;
  const text = degraded
    ? renderDegradedText(summary, degradeReason, locale)
    : renderFullText(summary, analysis, locale);

  if (hasChannel) {
    try {
      await alerts.sendAlert(subject, text);
    } catch (e) {
      // 投递失败不影响报告已落库的事实；记录到状态供前端查看
      console.error('[ai] 日报投递失败：', e.message);
    }
  } else {
    console.warn('[ai] 未配置通知通道，日报仅落库未发送（报告 ID:', report.id, '）');
  }

  // ⑤ 统一更新运行状态（schedule/manual 触发都刷新）：
  //    手动重试成功后应清除上次的「失败已降级」提示，否则前端状态横幅一直显示旧错误。
  //    与 schedule.js tick 中的更新逻辑保持同构（重复写幂等无害）。
  //    last_duration_ms 落库而非仅存内存，使状态跨进程重启仍可见。
  const finalStatus = degraded ? 'degraded' : 'ok';
  const finalMessage = degraded ? `AI 分析失败已降级：${degradeReason}` : '日报已生成并发送';
  db.setAiState({
    last_run_ts: Date.now(),
    last_status: finalStatus,
    last_error: degraded ? finalMessage : '',
    last_duration_ms: Date.now() - t0
  });

  return {
    status: finalStatus,
    report_id: report.id,
    degraded,
    message: finalMessage
  };
}

// ---- 运行锁：定时触发（schedule）与手动触发（/api/ai/run）共用同一把锁 ----
// 放在 report.js 而非 index.js，是为了避免 index.js ↔ schedule.js 的循环依赖：
// 两个触发源本就都 require report。命中锁时返回 { status:'busy' }，由调用方决定跳过/回 409。
let running = false;
async function runExclusive(opts) {
  if (running) return { status: 'busy', message: '已有分析任务在执行中' };
  running = true;
  try { return await generateAndSend(opts); }
  finally { running = false; }
}
const isRunning = () => running;

module.exports = {
  generateAndSend, runExclusive, isRunning,
  capHighlights, renderDiskLine,
  renderStatsText, renderFullText, renderDegradedText
};
