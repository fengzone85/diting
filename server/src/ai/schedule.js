// schedule.js —— AI 日报调度循环
//
// 设计要点（与项目现有 setInterval 调度风格一致，见 server.js:234/239）：
// 1. 每 60s 唤醒一次，检查「现在是否到达配置的发送时刻」。
// 2. 不用 node-cron（项目无此依赖，package.json 仅 6 个生产依赖）。
//    用「友好下拉式」配置：schedule_freq ∈ {daily, weekly} + schedule_time HH:MM。
//    覆盖 99% 的真实需求，普通用户也不会写错 cron 语法。
// 3. 用 ai_state.last_run_ts【防同日重复】：发过今天这一档就不再发，进程重启后从 DB 恢复。
// 4. running 标志【防重入】：一次生成耗时的 LLM 调用进行中时，下一轮 tick 直接跳过。
//
// 时区：按 config.tz_offset_hours 解释 HH:MM。默认东八区（8）。

const db = require('../db');
const { generateAndSend } = require('./report');

let timer = null;
let running = false;
const TICK_MS = 60000;

// 计算下一个「应发送时刻」的时间戳（ms）。
//   freq: 'daily' | 'weekly'（weekly=每周一）
//   time: 'HH:MM'
//   tzOffsetHours: 数字
// 返回「上一个应发送时刻」与「下一个应发送时刻」，用于判断当前是否处于「应已发送」窗口。
function computeSchedulePoint(freq, time, tzOffsetHours) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '08:00'));
  if (!m) return null;
  const hour = +m[1], minute = +m[2];
  if (hour > 23 || minute > 59) return null;

  // 当前 UTC 时间 + 偏移 = 配置时区的「本地时间」
  const now = Date.now();
  const localNow = new Date(now + tzOffsetHours * 3600000);
  // 在本地时区下取「今天 time」对应的 UTC 时间戳
  const localYear = localNow.getUTCFullYear();
  const localMonth = localNow.getUTCMonth();
  const localDate = localNow.getUTCDate();
  let targetLocal = new Date(Date.UTC(localYear, localMonth, localDate, hour, minute, 0, 0));
  // weekly：若今天不是周一（localDate.getUTCDay()===1），向前回溯到最近的周一
  if (freq === 'weekly') {
    const dow = targetLocal.getUTCDay(); // 0=Sun..6=Sat
    const diff = (dow + 6) % 7;          // 回到周一的偏移
    if (diff > 0) targetLocal = new Date(targetLocal.getTime() - diff * 86400000);
  }
  // 转回真实时间戳（减去偏移）
  const targetTs = targetLocal.getTime() - tzOffsetHours * 3600000;
  // 若该时刻已过，返回它作为「上一个应发送时刻」
  if (targetTs <= now) {
    return { lastScheduled: targetTs, nextScheduled: nextOccurrence(freq, targetTs, tzOffsetHours, hour, minute) };
  }
  // 还没到：上一个应发送时刻是上一个周期
  const prevTs = prevOccurrence(freq, targetTs, tzOffsetHours, hour, minute);
  return { lastScheduled: prevTs, nextScheduled: targetTs };
}

function nextOccurrence(freq, fromTs, tzOffsetHours, hour, minute) {
  const stepDays = freq === 'weekly' ? 7 : 1;
  return fromTs + stepDays * 86400000;
}
function prevOccurrence(freq, fromTs, tzOffsetHours, hour, minute) {
  const stepDays = freq === 'weekly' ? 7 : 1;
  return fromTs - stepDays * 86400000;
}

// 单次检查：判断是否到了应发送的时刻，且本次尚未发送过。
async function tick() {
  if (running) return; // 防重入
  const config = db.getAiConfig();
  if (!config.enabled) return;

  const sch = computeSchedulePoint(config.schedule_freq, config.schedule_time, config.tz_offset_hours);
  if (!sch) return;

  const state = db.getAiState();
  // 上一个应发送时刻 > 上次实际发送时刻 → 说明本周期还没发过，且该时刻已过 → 触发
  if (sch.lastScheduled > state.last_run_ts) {
    // 再容差：只在「应发送时刻」之后 30 分钟内才触发，避免长时间宕机后一开机就补发一份过期报告。
    // 超过 30 分钟则跳过本周期的补发，等下一个周期（防止补发过期数据误导用户）。
    const elapsed = Date.now() - sch.lastScheduled;
    if (elapsed > 30 * 60000) {
      // 视为已错过：把 last_run_ts 推进到 lastScheduled，避免每个 tick 都重新判断；同时更新 status 供前端展示
      db.setAiState(Object.assign(state, { last_run_ts: sch.lastScheduled, last_status: 'skipped', last_error: '' }));
      console.log('[ai] 错过发送时刻超过 30 分钟，跳过本次补发');
      return;
    }
    running = true;
    try {
      console.log('[ai] 到达发送时刻，开始生成日报（触发：schedule）');
      const r = await generateAndSend({ trigger: 'schedule' });
      // 无论成功还是降级，都更新 last_run_ts（degraded 也算「已生成」）
      db.setAiState({
        last_run_ts: Date.now(),
        last_status: r.status,
        last_error: r.status === 'degraded' ? (r.message || '') : (r.status === 'error' ? r.message : '')
      });
      console.log('[ai] 日报生成结束：', r.status, r.message || '');
    } catch (e) {
      // 生成过程抛异常：记录失败，但不更新 last_run_ts，让下一轮 tick 可重试
      db.setAiState(Object.assign(db.getAiState(), { last_status: 'error', last_error: e.message }));
      console.error('[ai] 日报生成异常：', e.message);
    } finally {
      running = false;
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  // 启动后立即检查一次（处理「宕机期间错过、刚重启」的情形，由上面的 30 分钟容差把关）
  setTimeout(tick, 5000);
  console.log('[ai] scheduler started (每 60s 检查发送时刻)');
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, computeSchedulePoint, nextOccurrence, prevOccurrence };
