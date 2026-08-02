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

module.exports = { daysUntil, cycleLabel };
