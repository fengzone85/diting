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
    disk_line: (pct, full) => `  磁盘：当前 ${pct}${full != null && full > 0 ? ` / 按当前增速约 ${full} 天后达 90%` : ''}`,
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
    disk_line: (pct, full) => `  Disk: current ${pct}${full != null && full > 0 ? ` / ~${full} days to 90% at current rate` : ''}`,
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
  if (b.days_until_expire == null) return t('expire_no_date', locale, cycle);
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
    if (s.disk && s.disk.current_pct != null) {
      const full = s.disk.estimated_full_days;
      lines.push(t('disk_line', locale, pct(s.disk.current_pct), full));
    }
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

  // ① 始终先做本地统计（降级基底）
  const summary = summarize({ periodHours: 24 });

  let analysis = null;
  let aiText = '';        // 模型原始返回文本，落库用
  let degradeReason = '';
  let degraded = false;

  // ② 尝试调用模型
  try {
    const result = await analyze(config, summary);
    aiText = result.text;
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
  const riskLevel = analysis ? (analysis.risk_level || '') : '';
  const aiSummary = analysis ? (analysis.summary || '') : '';
  const suggestion = analysis
    ? (Array.isArray(analysis.highlights) ? analysis.highlights.map(h => `[${h.agent_name||'-'}] ${h.suggestion||''}`).join('\n') : '')
    : (degraded ? 'AI 分析失败：' + degradeReason : '');
  const reportJson = JSON.stringify({ summary, analysis: analysis || { _parse_error: true, raw: aiText.slice(0, 2000) }, degraded, degrade_reason: degradeReason });

  const report = db.insertAiReport({
    period: summary.period,
    risk_level: riskLevel,
    summary: aiSummary,
    suggestion,
    report_json: reportJson,
    prompt_version: PROMPT_VERSION
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

  return {
    status: degraded ? 'degraded' : 'ok',
    report_id: report.id,
    degraded,
    message: degraded ? `AI 分析失败已降级：${degradeReason}` : '日报已生成并发送'
  };
}

module.exports = { generateAndSend, renderStatsText, renderFullText, renderDegradedText };
