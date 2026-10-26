'use strict';
// ============================================================
// 「在线」判定与离线阈值的**唯一**口径。
//
// 取值链：节点覆盖 > 分组覆盖 > 全局（UI 设置 > OFFLINE_THRESHOLD_SEC > 60）。
// 与 alerts.js 的告警判定**同源**（内部直接复用 alerts.resolveAgentThresholds）。
//
// 为什么需要这个模块（2026-10-26 核实到的真实缺陷）：
//   改造前有 4 套口径各自为政 ——
//     · alerts.js      逐节点解析（节点 > 分组 > 全局）        ← 正确
//     · compat.js      只看 OFFLINE_THRESHOLD_SEC env
//     · v1.js          只看 OFFLINE_THRESHOLD_SEC env
//     · ai/summarizer  只看全局 db.resolveAlertThresholds()
//   于是在面板把「离线阈值」调成非默认值、或给某节点设了覆盖之后：
//     - 面板/兼容接口说某节点「在线」，告警却说它「离线」并推通知；
//     - AI 日报（走全局）与告警（走向节点）结论不一致。
//   用户看到的自相矛盾就是这么来的。
//
// 性能：buildCtx() 一次性预取全局阈值 + 两张覆盖表（3 次查询，与节点数无关），
// 批量接口把 ctx 传下去即可，不会退化成逐节点 N×2 查库（公开端点会被高频轮询）。
// ============================================================
const db = require('./db');
const alerts = require('./alerts');

/**
 * 预取阈值上下文。批量渲染（列表/兼容接口/v1）时**每个请求调用一次**并复用。
 * @returns {{global: object, groupCache: Map<string,object>, nodeCache: Map<string,object>}}
 */
function buildCtx() {
  return {
    global: db.resolveAlertThresholds(),
    groupCache: new Map(db.listGroupAlertOverrides().map((r) => [r.grp, r])),
    nodeCache: new Map(db.listAlertOverrides().map((r) => [r.agent_id, r]))
  };
}

/** 某节点的生效阈值（节点 > 分组 > 全局）。 */
function thresholdsFor(a, ctx) {
  return alerts.resolveAgentThresholds(a, ctx);
}

/**
 * 是否在线。口径：距上次上报 < 生效的 offlineSec。
 * @param {object} a 节点行（需 last_seen）
 * @param {number} [now] 统一时间基准（批量时传同一个，避免逐个 Date.now() 造成边界抖动）
 * @param {object} [ctx] buildCtx() 的结果
 */
function isOnline(a, now, ctx) {
  if (!a || !a.last_seen) return false;
  const t = now == null ? Date.now() : now;
  return t - a.last_seen < thresholdsFor(a, ctx).offlineSec * 1000;
}

/**
 * 距判定离线的剩余毫秒（负数 = 已离线多久）。兼容层透出给高级主题精确渲染。
 */
function onlineTtl(a, now, ctx) {
  const t = now == null ? Date.now() : now;
  return thresholdsFor(a, ctx).offlineSec * 1000 - (t - ((a && a.last_seen) || 0));
}

module.exports = { buildCtx, thresholdsFor, isOnline, onlineTtl };
