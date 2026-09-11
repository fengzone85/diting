// index.js —— AI 运维分析模块门面
//
// 对外暴露 6 个函数，供 server.js / api.js 调用，内部细节不外泄：
//   start()        —— 启动调度（在 server.js 的 app.listen 回调里调用，同 alerts.start）
//   stop()         —— 停止调度
//   runNow()       —— 同步跑完一次生成（供内部/测试使用）
//   triggerRun()   —— 手动触发【异步】任务（供 POST /api/ai/run）：立即返回，后台执行
//   analyzeNode()  —— 单节点按需分析（供 POST /api/ai/analyze-node/:id），结果缓存 30 分钟
//   getStatus()    —— 返回运行状态（供 GET /api/ai/status）
//
// 运行锁（防「定时 + 手动」并发调 LLM）由 report.runExclusive 统一提供，两个触发源共用。
// 默认关闭：start() 内部会先读 ai_config.enabled，未启用则不挂定时器。
// 用户在后台开启后，下一次进程重启即自动生效；运行时改配置需手动重启或调 triggerRun。

const db = require('../db');
const sched = require('./schedule');
const { runExclusive, isRunning } = require('./report');
const sum = require('./summarizer');
const provider = require('./provider');
const { NODE_SYSTEM_PROMPT, buildNodeUserMessage, NODE_PROMPT_VERSION } = require('./prompt');

// 手动触发冷却：仅「上一次成功」需要等 5 分钟（防重复点击重复计费）；
// 降级（超时/限流/密钥错）最需要立刻重试，只等 60 秒；上一次异常则完全不冷却。
const COOLDOWN_MS = { ok: 5 * 60 * 1000, degraded: 60 * 1000, error: 0 };

// 仅内存态：started_at 供前端展示「已运行多久」；耗时结果写 ai_state.last_duration_ms（跨重启可见）
let startedAt = 0;

function start() {
  const config = db.getAiConfig();
  if (!config.enabled) {
    console.log('[ai] 未启用，调度器不启动（在后台「AI 运维分析」开启后重启生效）');
    return;
  }
  sched.start();
}

function stop() {
  sched.stop();
}

// 同步生成一次（保留给测试/内部调用）；同样走共用锁，避免与定时任务并发。
async function runNow() {
  return runExclusive({ trigger: 'manual' });
}

// 异步手动触发：立即返回，任务在后台跑。路由据 status 映射 HTTP 状态码
// （disabled→400 / busy→409 / cooldown→429 / accepted→202）。
async function triggerRun({ force = false } = {}) {
  if (!db.getAiConfig().enabled) {
    return { status: 'disabled', message: 'AI 分析未启用，请先在配置中开启' };
  }
  if (isRunning()) {
    return { status: 'busy', message: '已有分析任务在执行中' };
  }

  const st = db.getAiState();
  const wait = COOLDOWN_MS[st.last_status] || 0;
  const elapsed = Date.now() - (st.last_run_ts || 0);
  if (!force && wait > 0 && elapsed < wait) {
    return { status: 'cooldown', retry_after_s: Math.ceil((wait - elapsed) / 1000) };
  }

  startedAt = Date.now();
  // 后台执行：异常必须在此吞掉（写状态 + 日志），绝不能让 unhandledRejection 杀掉进程
  //（Node ≥15 默认 --unhandled-rejections=throw，与 server.js 顶部的兜底 handler 同旨）。
  runExclusive({ trigger: 'manual' })
    .catch((e) => {
      db.setAiState(Object.assign(db.getAiState(), { last_status: 'error', last_error: e.message }));
      console.error('[ai] 手动触发异常：', e.message);
    })
    .finally(() => { startedAt = 0; });

  return { status: 'accepted', message: '分析任务已开始，页面将自动刷新' };
}

// 间隔型频率不需要（也不应显示）schedule_time
const INTERVAL_FREQS = ['every6h', 'every12h'];

function getStatus() {
  const config = db.getAiConfig();
  const state = db.getAiState();
  const tz = `UTC${config.tz_offset_hours >= 0 ? '+' : ''}${config.tz_offset_hours}`;
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    period_hours: config.period_hours,
    schedule: INTERVAL_FREQS.includes(config.schedule_freq)
      ? `${config.schedule_freq} (${tz})`
      : `${config.schedule_freq} @ ${config.schedule_time} (${tz})`,
    last_run_ts: state.last_run_ts,
    last_status: state.last_status,
    last_error: state.last_error,
    last_duration_ms: state.last_duration_ms || 0,
    running: isRunning(),
    started_at: startedAt || null,
    report_count: db.countAiReports()
  };
}

// ---- 单节点按需分析（T11）----
// 成本控制：同一节点结果缓存 30 分钟；同一节点的并发请求合并（避免重复点击各打一次模型）。
const NODE_CACHE_TTL_MS = 30 * 60 * 1000;
const nodeCache = new Map();      // agentId -> { ts, payload }
const nodeInflight = new Map();   // agentId -> Promise

async function analyzeNode(agentId) {
  const config = db.getAiConfig();
  if (!config.enabled) return { status: 'disabled', message: 'AI 分析未启用，请先在配置中开启' };

  const cached = nodeCache.get(agentId);
  if (cached && Date.now() - cached.ts < NODE_CACHE_TTL_MS) {
    return Object.assign({ cached: true }, cached.payload);
  }
  if (nodeInflight.has(agentId)) return nodeInflight.get(agentId);

  const task = (async () => {
    const agent = db.getAgent(agentId);
    if (!agent) return { status: 'not_found', message: '节点不存在' };

    const summary = sum.summarizeOne(agent, { periodHours: 24 });
    const t0 = Date.now();
    try {
      const r = await provider.analyze(config, summary, {
        systemPrompt: NODE_SYSTEM_PROMPT,
        userMessage: buildNodeUserMessage(summary)
      });
      const parsed = provider.parseAnalysis(r.text);
      const payload = {
        status: 'ok',
        agent: { id: agent.id, name: summary.name, online: summary.online },
        analysis: parsed || { _parse_error: true, raw: String(r.text || '').slice(0, 1000) },
        usage: r.usage || null,
        duration_ms: Date.now() - t0,
        prompt_version: NODE_PROMPT_VERSION
      };
      nodeCache.set(agentId, { ts: Date.now(), payload });
      return payload;
    } catch (e) {
      return { status: 'error', message: e.message || String(e) };
    }
  })().finally(() => { nodeInflight.delete(agentId); });

  nodeInflight.set(agentId, task);
  return task;
}

module.exports = { start, stop, runNow, triggerRun, analyzeNode, getStatus };
