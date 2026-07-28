// index.js —— AI 运维分析模块门面
//
// 对外只暴露 4 个函数，供 server.js / api.js 调用，内部细节不外泄：
//   start()      —— 启动调度（在 server.js 的 app.listen 回调里调用，同 alerts.start）
//   stop()       —— 停止调度
//   runNow()     —— 手动触发一次（供 POST /api/ai/run）
//   getStatus()  —— 返回运行状态（供 GET /api/ai/status）
//
// 默认关闭：start() 内部会先读 ai_config.enabled，未启用则不挂定时器。
// 用户在后台开启后，下一次进程重启即自动生效；运行时改配置需手动重启或调 runNow。

const db = require('../db');
const sched = require('./schedule');
const { generateAndSend } = require('./report');

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

// 手动触发：跳过调度时刻检查，立即生成。不修改 last_run_ts（那是调度器专用）。
async function runNow() {
  return generateAndSend({ trigger: 'manual' });
}

function getStatus() {
  const config = db.getAiConfig();
  const state = db.getAiState();
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    schedule: `${config.schedule_freq} @ ${config.schedule_time} (UTC${config.tz_offset_hours >= 0 ? '+' : ''}${config.tz_offset_hours})`,
    last_run_ts: state.last_run_ts,
    last_status: state.last_status,
    last_error: state.last_error,
    report_count: db.countAiReports()
  };
}

module.exports = { start, stop, runNow, getStatus };
