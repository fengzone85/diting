'use strict';
// ============================================================
// 应用层限流公共实现（审查 C3 / C-3）
//
// 修复原实现的两个缺陷：
//   C3  — 表满（MAP_CAP）时先 `clear()` 后 `set()`：整表清空会把当前攻击者
//         的计数一并清零，限形同虚设。
//   C-3 — 全局定时器到期整表 `clear()`：60s 窗口被截断到 1s，攻击者在重置
//         边界前后各发满配额即得 2 倍速率（login/setup/register 均 60s 表）。
//
// 现改为：惰性过期（读取时判断 reset）+ 超限淘汰最旧（不清表）+ 当前 IP 永不被
// 淘汰；不再有任何整表清空定时器。内存有界（≤ MAP_CAP 条），且窗口语义精确。
// ============================================================
const MAP_CAP = 10000;

// 记一次命中。返回 false 表示已超速（调用方应 429）；true 放行。
// map: Map<ip, {reset, count}>；windowMs: 窗口毫秒；max: 窗口内最大次数。
function rateLimitTouch(map, ip, windowMs, max) {
  const now = Date.now();
  if (map.size >= MAP_CAP) {
    // ① 先删过期条目（惰性过期，不清表）
    for (const [k, v] of map) { if (now > v.reset) map.delete(k); }
    // ② 仍满：逐条淘汰 reset 最早的（永不动当前 IP），直到有空间
    while (map.size >= MAP_CAP) {
      let oldestKey = null, oldestReset = Infinity;
      for (const [k, v] of map) {
        if (k === ip) continue;
        if (v.reset < oldestReset) { oldestReset = v.reset; oldestKey = k; }
      }
      if (oldestKey === null) break; // 表中只剩当前 IP，无法再淘汰
      map.delete(oldestKey);
    }
  }
  let rec = map.get(ip);
  if (!rec || now > rec.reset) rec = { reset: now + windowMs, count: 0 };
  rec.count++;
  map.set(ip, rec);
  return rec.count <= max;
}

module.exports = { rateLimitTouch, MAP_CAP };
