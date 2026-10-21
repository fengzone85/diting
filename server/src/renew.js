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

/**
 * 自动续费：到期日推进一个计费周期（对齐 Komari utils/renewal/renewal.go 的口径）。
 *
 * 触发条件（与 Komari 一致）：
 *   - 仅当 auto_renewal 开启、计费周期 > 0、且 expire_at 有效（年份 ≥ 2）时由调用方判定
 *   - 到期日已过期，或与「今天」是同一天（SameSystemDate）
 *   - 到期日若 > now + 100 年（表示长期/永不到期）则跳过
 * 周期映射（Komari 原文）：27–32 天≈1 月、87–95≈3 月、175–185≈6 月、
 *   360–370≈1 年、720–750≈2 年、1080–1150≈3 年、1800–1850≈5 年，其余按天数累加。
 *   基准：过期超过 30 天则以「今天」为基准，否则以原到期日为基准（避免长期未开机导致连补多期）。
 *
 * @param {string} expireAt 'YYYY-MM-DD'
 * @param {Date|number} now
 * @param {number} cycleDays 计费周期天数（>0）
 * @returns {string|null} 新的 'YYYY-MM-DD'；不应续费时返回 null
 */
function autoRenewExpire(expireAt, now, cycleDays) {
  const cycle = Number(cycleDays);
  if (!(cycle > 0)) return null;
  const nowDate = now instanceof Date ? now : new Date(now);
  const parsed = expireAt ? new Date(expireAt + 'T00:00:00') : null;
  if (!parsed || isNaN(parsed.getTime())) return null;
  if (parsed.getFullYear() < 2) return null;

  const today = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const expireDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  // 未到期（且不是当天）→ 不动
  if (expireDay.getTime() > today.getTime()) return null;
  // 长期/永不到期（> 100 年）→ 不动
  const hundredYears = new Date(today.getFullYear() + 100, today.getMonth(), today.getDate());
  if (expireDay.getTime() > hundredYears.getTime()) return null;

  // 过期超过 30 天：从今天起算，避免一次补多期
  const thirtyDaysAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30);
  const base = expireDay.getTime() < thirtyDaysAgo.getTime() ? today : expireDay;

  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  if (cycle >= 27 && cycle <= 32) next.setMonth(next.getMonth() + 1);
  else if (cycle >= 87 && cycle <= 95) next.setMonth(next.getMonth() + 3);
  else if (cycle >= 175 && cycle <= 185) next.setMonth(next.getMonth() + 6);
  else if (cycle >= 360 && cycle <= 370) next.setFullYear(next.getFullYear() + 1);
  else if (cycle >= 720 && cycle <= 750) next.setFullYear(next.getFullYear() + 2);
  else if (cycle >= 1080 && cycle <= 1150) next.setFullYear(next.getFullYear() + 3);
  else if (cycle >= 1800 && cycle <= 1850) next.setFullYear(next.getFullYear() + 5);
  else next.setDate(next.getDate() + cycle);

  const out = fmtLocalDate(next);
  return out === expireAt ? null : out;
}

module.exports = { nextExpire, fmtLocalDate, autoRenewExpire };
