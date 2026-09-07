// util.js —— 服务端通用工具函数（无副作用，纯计算）
//
// 这些工具被 api.js / alerts.js / ai/summarizer.js 等共享，避免跨模块重复实现。

'use strict';

// 计算 dateStr（YYYY-MM-DD）距今天的天数。
// 返回 null 表示未设置或无效；负数表示已过期。
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}

// 计费周期天数转中文简称。
function cycleLabel(days) {
  return { 30: '月', 90: '季', 180: '半年', 365: '年', 730: '两年', 1095: '三年', 0: '白嫖' }[days] || `${days}天`;
}

// Express 4 不会捕获 async handler 抛出的 rejection：async 函数内任何 throw（含同步 throw）
// 都会变成 unhandledRejection，而 Node ≥15 起默认 --unhandled-rejections=throw，会直接杀进程。
// 用此包装把 rejection 转为 next(err)，交给统一错误中间件处理。
// 约定：所有新增 async 路由都必须套 asyncHandler。
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { daysUntil, cycleLabel, asyncHandler };
