'use strict';
// ============================================================
// F12 容量保险丝：metrics 行数 + 库文件字节双水位
//
// 目标不是「省空间」，而是「保住监控本身」：库涨到不可控时，实时数据与告警仍然
// 可用，只把历史明细停下来，等管理员清理或调阈值。
//
//   80%（warn）：发一次 capacity 告警（notify 事件字典里的 'capacity'）+ 顶部黄条；
//   100%（full）：只跳过 metrics 落库并计数 —— /report 照常 200，告警判定与
//                 实时数据（agents 表、traffic_state）不受影响。
//
// 红线：不自动删数据、不自动 VACUUM（计划 §5 F12）。清理是显式操作
// （POST /api/admin/capacity/cleanup → 复用现有 retention prune）。
// ============================================================
const fs = require('node:fs');
const db = require('./db');

const STATE_KEY = 'capacity_state';
const WARN_RATIO = 0.8;
const DEFAULT_MAX_ROWS = 2000000;      // 200 万行
const DEFAULT_MAX_MB = 2048;           // 2 GiB
const CACHE_TTL_MS = 60000;            // 行数 COUNT(*) 有成本，60s 量一次
const SKIP_PERSIST_EVERY = 10;         // 跳过计数每 10 次落一次库，避免每 report 写库

let cache = null;
let skipped = 0;
let persistedSkipped = 0;
let lastNotifiedLevel = '';

// 重启后恢复「已告警过的水位」与跳过计数：level 没变化就不重复发告警。
try {
  const st = JSON.parse(db.getConfig(STATE_KEY) || 'null');
  if (st && typeof st === 'object') {
    lastNotifiedLevel = String(st.notified_level || '');
    skipped = Number(st.skipped) || 0;
    persistedSkipped = skipped;
  }
} catch (e) { /* 配置损坏按首次处理 */ }

function resolveLimits() {
  const ui = db.getUiSettings();
  const rows = Number(ui.capacity_max_rows);
  const mb = Number(ui.capacity_max_mb);
  return {
    enabled: ui.capacity_enabled !== false,
    max_rows: Number.isFinite(rows) && rows > 0 ? Math.trunc(rows) : DEFAULT_MAX_ROWS,
    max_bytes: (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024
  };
}

// 纯函数：给定度量与阈值算水位，便于边界测试（79.9% / 80% / 100%）。
function computeLevel({ rows, bytes, max_rows, max_bytes }) {
  const rowPct = max_rows > 0 ? rows / max_rows : 0;
  const bytePct = max_bytes > 0 ? bytes / max_bytes : 0;
  const pct = Math.max(rowPct, bytePct);
  const level = pct >= 1 ? 'full' : (pct >= WARN_RATIO ? 'warn' : 'ok');
  return {
    row_pct: Number(rowPct.toFixed(4)),
    byte_pct: Number(bytePct.toFixed(4)),
    pct: Number(pct.toFixed(4)),
    level
  };
}

function measure() {
  let rows = 0;
  try { rows = db.db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n || 0; } catch (e) { rows = 0; }
  let bytes = 0;
  try { bytes = fs.statSync(db.db.name).size; } catch (e) { bytes = 0; }
  return { rows, bytes };
}

function persistState(s) {
  try {
    db.setConfig(STATE_KEY, JSON.stringify({
      level: s.level,
      rows: s.rows,
      bytes: s.bytes,
      pct: s.pct,
      skipped,
      ts: s.ts,
      notified_level: lastNotifiedLevel
    }));
    persistedSkipped = skipped;
  } catch (e) { /* 只读/损坏库：状态丢失不影响停写判断（内存仍在） */ }
}

function notifyLevel(level, s) {
  if (level === 'ok') { lastNotifiedLevel = 'ok'; return; }
  if (lastNotifiedLevel === level) return;
  lastNotifiedLevel = level;
  const mb = Math.round(s.bytes / (1024 * 1024));
  const pct = Math.round(s.pct * 100);
  const detail = level === 'full'
    ? `数据库已达容量硬限（${pct}%：${s.rows} 行 / ${mb} MB），已暂停历史明细写入；/report、告警与实时数据不受影响。请清理明细或调高阈值。`
    : `数据库容量已达 ${pct}%（${s.rows} 行 / ${mb} MB），达到 100% 后将暂停历史明细写入（实时数据与告警不受影响）。`;
  // 延迟 require + 异步投递：告警失败绝不能影响 /report 主流程。
  Promise.resolve()
    .then(() => require('./alerts').sendAlert(`[监控] 数据库容量${level === 'full' ? '硬限' : '预警'}`, detail, 'capacity', {}))
    .catch(() => {});
}

function output(s) {
  return {
    enabled: s.enabled,
    level: s.level,
    rows: s.rows,
    bytes: s.bytes,
    max_rows: s.max_rows,
    max_bytes: s.max_bytes,
    row_pct: s.row_pct,
    byte_pct: s.byte_pct,
    pct: s.pct,
    paused: s.enabled && s.level === 'full',
    skipped,
    retention_days: db.getRetentionDays(),
    ts: s.ts
  };
}

function getStatus(opts = {}) {
  const now = Date.now();
  if (!opts.refresh && cache && now - cache.ts < CACHE_TTL_MS) return output(cache);

  const limits = resolveLimits();
  if (!limits.enabled) {
    cache = {
      ts: now, enabled: false, rows: 0, bytes: 0,
      max_rows: limits.max_rows, max_bytes: limits.max_bytes,
      row_pct: 0, byte_pct: 0, pct: 0, level: 'ok'
    };
    return output(cache);
  }

  const m = measure();
  const lv = computeLevel({ ...m, ...limits });
  const prevLevel = cache ? cache.level : '';
  cache = { ts: now, enabled: true, ...m, ...limits, ...lv };

  if (lv.level !== prevLevel) {
    notifyLevel(lv.level, cache);
    persistState(cache);
  }
  return output(cache);
}

// /report 的历史落库开关。硬限时返回 false 并计数；实时数据与告警由调用方照常处理。
function shouldWriteHistory() {
  const s = getStatus();
  if (s.enabled && s.level === 'full') {
    skipped += 1;
    if (skipped - persistedSkipped >= SKIP_PERSIST_EVERY) persistState(cache || s);
    return false;
  }
  return true;
}

// 一键「清理并恢复」：只跑既有 retention 清理，不额外删数据、不 VACUUM。
function cleanup() {
  const deleted = db.prune(db.getRetentionDays());
  const s = getStatus({ refresh: true });
  return { deleted, ...s };
}

// 测试用：清空进程内状态（避免用例间互相影响）。
function _resetForTest() {
  cache = null;
  skipped = 0;
  persistedSkipped = 0;
  lastNotifiedLevel = '';
}

module.exports = {
  STATE_KEY,
  WARN_RATIO,
  DEFAULT_MAX_ROWS,
  DEFAULT_MAX_MB,
  computeLevel,
  resolveLimits,
  measure,
  getStatus,
  shouldWriteHistory,
  cleanup,
  _resetForTest
};
