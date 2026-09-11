// schedule.test.js —— computeSchedulePoint 边界测试
// 运行: cd server && node src/ai/schedule.test.js
// 通过 module.exports 直接拿到内部纯函数，不依赖 DB / 不启动调度器。

// 必须在 require schedule 之前设置：db.js 在 require 时就读取 DB_PATH 并建库
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const { computeSchedulePoint, nextOccurrence, prevOccurrence } = require('./schedule');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  }
}

const DAY = 86400000;

console.log('—— daily 频率 ——');
{
  const r = computeSchedulePoint('daily', '08:00', 8);
  check('daily: next - last = 1天', r.nextScheduled - r.lastScheduled, DAY);
  check('daily: lastScheduled <= now', r.lastScheduled <= Date.now(), true);
  check('daily: nextScheduled > now', r.nextScheduled > Date.now(), true);
}
{
  const r = computeSchedulePoint('daily', '00:00', 0);
  check('daily 00:00: next - last = 1天', r.nextScheduled - r.lastScheduled, DAY);
}
{
  check('daily: 无效 time(99:99) → null', computeSchedulePoint('daily', '99:99', 8), null);
  // 空 time 走默认 08:00（fail-safe：避免调度器因 null 静默停转）
  check('daily: 空 time 走默认 08:00', typeof computeSchedulePoint('daily', '', 8), 'object');
  check('daily: 有效调用不抛', typeof computeSchedulePoint('daily', '08:00', 8), 'object');
}

console.log('—— weekly 频率 ——');
{
  const r = computeSchedulePoint('weekly', '08:00', 8);
  check('weekly: next - last = 7天', r.nextScheduled - r.lastScheduled, 7 * DAY);
  check('weekly: lastScheduled <= now', r.lastScheduled <= Date.now(), true);
  // lastScheduled 应是周一：把它转成 UTC+8 后 getUTCDay() === 1
  const lastLocal = new Date(r.lastScheduled + 8 * 3600000);
  check('weekly: lastScheduled 是周一', lastLocal.getUTCDay(), 1);
}
{
  const r = computeSchedulePoint('weekly', '23:59', -5);
  check('weekly 负偏移: next - last = 7天', r.nextScheduled - r.lastScheduled, 7 * DAY);
}

console.log('—— 时区边界 ——');
{
  const r = computeSchedulePoint('daily', '12:00', 14);
  check('tz+14: next - last = 1天', r.nextScheduled - r.lastScheduled, DAY);
  const r2 = computeSchedulePoint('daily', '12:00', -12);
  check('tz-12: next - last = 1天', r2.nextScheduled - r2.lastScheduled, DAY);
}

console.log('—— 辅助函数 ——');
{
  check('nextOccurrence daily = +1天', nextOccurrence('daily', 1000, 8, 8, 0), 1000 + DAY);
  check('nextOccurrence weekly = +7天', nextOccurrence('weekly', 1000, 8, 8, 0), 1000 + 7 * DAY);
  check('prevOccurrence daily = -1天', prevOccurrence('daily', 1000, 8, 8, 0), 1000 - DAY);
  check('prevOccurrence weekly = -7天', prevOccurrence('weekly', 1000, 8, 8, 0), 1000 - 7 * DAY);
}

console.log('—— 间隔型频率（every6h / every12h，对齐当地整点边界）——');
{
  const H = 3600000;
  const r = computeSchedulePoint('every6h', '00:00', 8);
  check('every6h: next - last = 6小时', r.nextScheduled - r.lastScheduled, 6 * H);
  check('every6h: lastScheduled <= now', r.lastScheduled <= Date.now(), true);
  check('every6h: nextScheduled > now', r.nextScheduled > Date.now(), true);
  // 对齐当地 00/06/12/18：换算到本地后小时数应为 6 的倍数
  check('every6h: 对齐当地 6 小时边界', new Date(r.lastScheduled + 8 * H).getUTCHours() % 6, 0);
}
{
  const H = 3600000;
  const r = computeSchedulePoint('every12h', '00:00', 0);
  check('every12h: next - last = 12小时', r.nextScheduled - r.lastScheduled, 12 * H);
  check('every12h: 对齐当地 12 小时边界', new Date(r.lastScheduled).getUTCHours() % 12, 0);
}
{
  // 间隔型不依赖 schedule_time：即使传了非法时刻也应正常返回
  const r = computeSchedulePoint('every6h', '99:99', 8);
  check('every6h: 忽略 schedule_time', typeof r, 'object');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
