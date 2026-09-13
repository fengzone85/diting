'use strict';
// 续期日期计算：全程走「本地日历日」口径，禁止 toISOString()（UTC），
// 否则 UTC+8 部署下每次续期都会提前 1 天且逐次累积（2026-09 体检 L-1）。

/**
 * 把 Date 按「本地时区」格式化为 YYYY-MM-DD。
 * 刻意不用 toISOString()：后者按 UTC 格式化，在 UTC+8 下会把本地午夜换算回前一天。
 * @param {Date} d
 * @returns {string} 'YYYY-MM-DD'
 */
function fmtLocalDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/**
 * 计算续期后的到期日（本地日历日口径）。
 *
 * 语义（与 /agents/:id/renew 现状保持）：
 *   - 若 expire_at 存在且晚于 now   → 从 expire_at 起算
 *   - 否则                          → 从 now 当天起算
 *   - cycleDays<=0（白嫖）           → 不改变到期日，仅刷新为「起始日」本身
 *
 * @param {string} expireAt   'YYYY-MM-DD'，可为空
 * @param {Date|number} now   当前时间
 * @param {number} cycleDays  计费周期天数
 * @returns {string} 'YYYY-MM-DD'
 */
function nextExpire(expireAt, now, cycleDays) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const parsed = expireAt ? new Date(expireAt + 'T00:00:00') : null;
  const validParsed = parsed && !isNaN(parsed.getTime()) ? parsed : null;

  const cur = (validParsed && validParsed > nowDate) ? validParsed : nowDate;
  // 归零到本地午夜，避免用「当前时刻」做基准导致后续日期带时间分量
  const next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
  // 日历日加法（setDate 会自动跨月/跨年），免 DST 与毫秒误差
  next.setDate(next.getDate() + Math.max(0, Number(cycleDays) || 0));
  return fmtLocalDate(next);
}

module.exports = { nextExpire, fmtLocalDate };
