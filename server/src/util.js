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

// 把 IPv6 地址解析为 128 位 BigInt；非 IPv6（含 IPv4/主机名）或非法返回 null。
// 从 auth.js 迁出：auth.js 与 ratelimit.js 都需要它（限流 /64 归桶），
// 放 util 避免两处实现漂移。纯计算，无副作用。
function ip6ToBits(ip) {
  try {
    // 手动展开压缩格式 :: 与全写为 8 段 × 16 位
    let s = String(ip).toLowerCase().trim();
    if (!s.includes(':')) return null;
    // 展开 ::
    let parts = s.split('::');
    if (parts.length > 2) return null; // 非法
    let head = parts[0] ? parts[0].split(':') : [];
    let tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    const full = [...head, ...Array(missing).fill('0'), ...tail];
    if (full.length !== 8) return null;
    let bits = 0n;
    for (let i = 0; i < 8; i++) {
      const segment = parseInt(full[i] || '0', 16);
      if (isNaN(segment) || segment < 0 || segment > 0xffff) return null;
      bits = (bits << 16n) | BigInt(segment);
    }
    return bits;
  } catch (e) {
    return null;
  }
}

module.exports = { daysUntil, cycleLabel, asyncHandler, ip6ToBits };
