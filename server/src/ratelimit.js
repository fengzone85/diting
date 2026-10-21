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

// ============================================================
// 登录暴力防护（F9）：失败计数 + 指数封禁
//
// 公式对齐 nezha model/waf.go 的 count^4：连续失败 N 次 → 封禁 N^4 秒（上限 24h）。
// 第 FAIL_LIMIT（默认 3）次失败即进入封禁；封禁期内请求直接 429 + Retry-After；
// 成功登录清零。
//
// 维度说明（2026-10-21 实现时修正方案偏差）：原方案写 key = ip|username，但 diting 的
// 登录是「Admin Token + TOTP」，根本没有 username 概念（api.js /login 只收 token 与
// totp 两个字段）。故以 key = ip 为主体；key 由调用方构造，将来若引入账号体系，
// 直接扩展为 ip|username 即可，主逻辑零改动。
//
// 持久化钩子：loadState()/saveState()/deleteState() 默认内存态；未来升级持久化时只替换
// 这三个钩子（对齐 alerts.js 的 db.getAlertState/setAlertState 模式），主逻辑零改动。
// 重启即清零 —— 已在 CHANGELOG 与 docs/security.md 注明（内存态是刻意取舍）。
//
// 内存有界：条目超上限时先删已过期（失败计数 TTL 到期），再淘汰 expiresAt 最早的
// （永不动当前 key），与 rateLimitTouch 的淘汰策略一致。
// ============================================================
const LOGIN_GUARD_CAP = 10000;         // 状态表上限（与 MAP_CAP 同量级）
const LOGIN_GUARD_FAIL_LIMIT = 3;      // 第 N 次失败起封禁
const LOGIN_GUARD_MAX_BAN_SEC = 86400; // 封禁上限 24h
const LOGIN_GUARD_FAIL_TTL_MS = 3600 * 1000; // 失败计数保留时长（1h 无失败则清零）

// 内存态存储。仅供单测直接构造「封禁已过期」等边界场景，生产代码不直接读写。
const loginGuardState = new Map();

// ---- 持久化钩子（默认内存态；未来只替换这三个实现即可升级为持久化） ----
function loadState(key) { return loginGuardState.get(key) || null; }
function saveState(key, rec) { evictLoginGuard(key); loginGuardState.set(key, rec); }
function deleteState(key) { loginGuardState.delete(key); }

// 内存有界：先删过期条目，再淘汰 expiresAt 最早的（永不动当前 key）。
function evictLoginGuard(currentKey) {
  if (loginGuardState.size < LOGIN_GUARD_CAP) return;
  const now = Date.now();
  for (const [k, v] of loginGuardState) {
    if (!v.expiresAt || v.expiresAt <= now) loginGuardState.delete(k);
  }
  while (loginGuardState.size >= LOGIN_GUARD_CAP) {
    let oldestKey = null, oldestExp = Infinity;
    for (const [k, v] of loginGuardState) {
      if (k === currentKey) continue;
      const exp = v.expiresAt || 0;
      if (exp < oldestExp) { oldestExp = exp; oldestKey = k; }
    }
    if (oldestKey === null) break; // 表中只剩当前 key，无法再淘汰
    loginGuardState.delete(oldestKey);
  }
}

// 检查是否处于封禁期。返回 { allowed, retryAfterSec, fails }。
function loginGuard(key) {
  const now = Date.now();
  const rec = loadState(key);
  if (!rec) return { allowed: true, retryAfterSec: 0, fails: 0 };
  if (rec.bannedUntil && rec.bannedUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((rec.bannedUntil - now) / 1000),
      fails: rec.fails || 0,
    };
  }
  // 封禁已到期：解除封禁标记；失败计数按 TTL 决定是否保留
  if (rec.bannedUntil) rec.bannedUntil = 0;
  if (rec.expiresAt && rec.expiresAt <= now) {
    deleteState(key);
    return { allowed: true, retryAfterSec: 0, fails: 0 };
  }
  return { allowed: true, retryAfterSec: 0, fails: rec.fails || 0 };
}

// 记录一次失败。返回 { banned, retryAfterSec, fails }。
function loginGuardFail(key) {
  const now = Date.now();
  let rec = loadState(key);
  if (!rec || (rec.expiresAt && rec.expiresAt <= now)) rec = { fails: 0, bannedUntil: 0, expiresAt: 0 };
  rec.fails = (rec.fails || 0) + 1;
  let banned = false;
  let retryAfterSec = 0;
  if (rec.fails >= LOGIN_GUARD_FAIL_LIMIT) {
    // count^4：3→81s、4→256s、5→625s … 上限 24h
    retryAfterSec = Math.min(LOGIN_GUARD_MAX_BAN_SEC, Math.pow(rec.fails, 4));
    rec.bannedUntil = now + retryAfterSec * 1000;
    banned = true;
  }
  // 记录存活期至少覆盖封禁期：否则 24h 封禁会在 1h 后因 TTL 到期被清零，
  // 封禁结束瞬间计数归零 → 攻击者每 24h 可无成本重置一次。
  rec.expiresAt = Math.max(now + LOGIN_GUARD_FAIL_TTL_MS, rec.bannedUntil || 0);
  saveState(key, rec);
  return { banned, retryAfterSec, fails: rec.fails };
}

// 成功登录：清零（该 IP 的失败计数与封禁一并解除）。
function loginGuardClear(key) { deleteState(key); }

module.exports = {
  rateLimitTouch, MAP_CAP,
  loginGuard, loginGuardFail, loginGuardClear,
  LOGIN_GUARD_FAIL_LIMIT, LOGIN_GUARD_MAX_BAN_SEC,
  // 仅供单测构造边界场景（生产代码不应直接改写状态）
  _loginGuardState: loginGuardState,
};
