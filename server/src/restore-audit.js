'use strict';
// ============================================================
// F8.6 恢复后清理与一致性审查
//
// 恢复是「整库回滚」：库里的时间基准、折叠水位线、流量累计器都会一起被拨回
// 过去，而 prune（每小时）与流量差量（traffic.js 的 last_rx 递增）都默认
// 「时间是单调的」。不做检查 = 让旧数据撞上新时钟。
//
// 链路：
//   1. diting.sh 在替换数据库前把 admin_config.restore_audit_pending 写进
//      「即将生效」的库（写库失败时降级为备份目录下 .restore_audit_pending.json）；
//   2. 服务启动时调用 runRestoreAudit()，检测到标记即跑 8 项检查；
//   3. 报告写入 admin_config.restore_audit_last（备份页面板），审计写
//      restore_completed —— 必须写进**恢复后的库**，否则会随旧库一起消失。
//
// 降级：S2 折叠（metrics_hour / metrics_rolled）未落地、F11 软删列缺失、
// F12 容量保险丝被关闭时，对应检查标 skipped，不得当成失败阻断启动。
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { BACKUP_DIR } = require('./backups');

const PENDING_FILE = path.join(BACKUP_DIR, '.restore_audit_pending.json');
// 第 2 项：过期数据占比超过该阈值时提示「下次 prune 会删掉多少」
const RETENTION_WARN_RATIO = 0.3;
// 第 5 项：缺口阈值下限（缺口判定 = max(3 × 上报间隔, 1h)）
const GAP_FLOOR_MS = 3600000;
// 第 7 项：与 db.js 的 SOFT_DELETE_GRACE_MS 保持一致（7 天）
const SOFT_DELETE_GRACE_MS = 7 * 86400000;
const HOUR_MS = 3600000;

function tableExists(name) {
  try {
    return Boolean(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch (e) { return false; }
}

function tableColumns(name) {
  try {
    return db.db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
  } catch (e) { return []; }
}

function readPendingFile() {
  try {
    const o = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch (e) { return null; }
}

function clearPendingFile() {
  try { fs.unlinkSync(PENDING_FILE); } catch (e) { /* 不存在则忽略 */ }
}

// 标记来源：库内优先（随恢复库一起生效），文件兜底（无 sqlite3 的宿主）。
function readPending() {
  const fromDb = db.getRestoreAuditPending();
  if (fromDb) return { pending: fromDb, source: 'db' };
  const fromFile = readPendingFile();
  if (fromFile) return { pending: fromFile, source: 'file' };
  return null;
}

function check(id, status, value) {
  return { id, status, value };
}

// 1) 结构完整性：损坏的库继续跑只会写坏更多东西，直接拒绝启动。
function checkIntegrity() {
  try {
    const rows = db.db.pragma('integrity_check');
    const v = rows && rows[0] ? (rows[0].integrity_check || Object.values(rows[0])[0]) : '';
    return check('integrity', v === 'ok' ? 'ok' : 'fail', { result: String(v).slice(0, 200) });
  } catch (e) {
    return check('integrity', 'fail', { result: (e.message || String(e)).slice(0, 200) });
  }
}

// 2) retention 裁剪预演：恢复自很久以前的备份时，下一次 prune 会删掉大量数据，
//    必须提前告诉用户，而不是等它静默消失。
//    除总量/占比外，还要给出最早/最晚过期时间与「批次」（按保留周期分段），
//    否则用户只知道「会删 5000 行」，不知道删的是哪个时间段。
const RETENTION_MAX_BUCKETS = 8;
function checkRetention(now) {
  const retentionDays = db.getRetentionDays();
  const cutoff = now - retentionDays * 86400000;
  let total = 0;
  let stats = { n: 0, mn: 0, mx: 0 };
  try {
    total = db.db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n || 0;
    if (total) {
      stats = db.db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS mn, MAX(ts) AS mx FROM metrics WHERE ts < ?').get(cutoff)
        || { n: 0, mn: 0, mx: 0 };
    }
  } catch (e) {
    return check('retention', 'skipped', { reason: e.message });
  }
  const expired = stats.n || 0;
  const ratio = total ? expired / total : 0;

  // 批次：从 cutoff 往回每 retentionDays 一段（idx 越大越旧），最多 8 批，避免报告膨胀。
  let buckets = [];
  let truncated = false;
  if (expired) {
    try {
      const span = retentionDays * 86400000;
      const rows = db.db.prepare(`SELECT CAST((? - ts) / ? AS INTEGER) AS idx,
          COUNT(*) AS rows, MIN(ts) AS from_ts, MAX(ts) AS to_ts
        FROM metrics WHERE ts < ?
        GROUP BY idx ORDER BY idx DESC LIMIT ?`).all(cutoff, span, cutoff, RETENTION_MAX_BUCKETS);
      buckets = rows.map((b) => ({ rows: b.rows, from_ts: b.from_ts, to_ts: b.to_ts }));
      if (expired > buckets.reduce((s, b) => s + b.rows, 0)) truncated = true;
    } catch (e) { /* 批次统计失败不影响总量结论 */ }
  }

  return check('retention', ratio > RETENTION_WARN_RATIO ? 'warn' : 'ok', {
    retention_days: retentionDays,
    total_rows: total,
    expired_rows: expired,
    ratio: Number(ratio.toFixed(4)),
    earliest_ts: stats.mn || 0,
    latest_ts: stats.mx || 0,
    buckets,
    truncated
  });
}

// S2 折叠模块的追赶入口：S2 落地后导出 catchUpNow/foldNow/fold 任一即可。
// 未落地（当前状态）返回 skipped，不阻断启动。
function triggerFoldCatchUp() {
  for (const mod of ['./metrics-fold', './folding']) {
    let m;
    try {
      m = require(mod);
    } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND') continue;
      return `error:${e.message}`;
    }
    const fn = m.catchUpNow || m.foldNow || m.fold;
    if (typeof fn === 'function') {
      try { fn(); return 'done'; } catch (e) { return `error:${e.message}`; }
    }
    return 'skipped:no_entry';
  }
  return 'skipped:folding_module_missing';
}

// 3) 折叠水位线越界重置（恢复后 watermark 可能指向未来/过去）
// 4) 明细/小时重叠：以明细为准删除重叠小时行，避免 S2.5 融合查询双计
function checkFolding() {
  if (!tableExists('metrics_hour')) {
    return [
      check('folding', 'skipped', { reason: 'folding_not_enabled' }),
      check('overlap', 'skipped', { reason: 'folding_not_enabled' })
    ];
  }
  const mm = db.db.prepare('SELECT MIN(ts) AS mn, MAX(ts) AS mx FROM metrics').get();
  if (!mm || !mm.mn) {
    return [
      check('folding', 'skipped', { reason: 'no_detail_rows' }),
      check('overlap', 'skipped', { reason: 'no_detail_rows' })
    ];
  }
  const low = Math.floor(mm.mn / HOUR_MS) * HOUR_MS;
  const high = Math.floor(mm.mx / HOUR_MS) * HOUR_MS + HOUR_MS;
  // 空字符串不能被 Number('') 当成 0 —— 否则「未设置」会伪装成合法水位线。
  const rolledCfg = db.getConfig('metrics_rolled');
  const rolledRaw = (rolledCfg === null || rolledCfg === undefined || rolledCfg === '')
    ? NaN
    : Number(rolledCfg);
  let rolled = rolledRaw;
  let reset = false;
  if (!Number.isFinite(rolledRaw) || rolledRaw < low || rolledRaw > high) {
    rolled = low;
    reset = true;
    try { db.setConfig('metrics_rolled', String(low)); } catch (e) { /* 只读库等场景忽略 */ }
  }
  let overlapDeleted = 0;
  const cols = tableColumns('metrics_hour');
  const tsCol = cols.includes('hour_ts') ? 'hour_ts' : (cols.includes('ts') ? 'ts' : '');
  if (tsCol) {
    try {
      overlapDeleted = db.db.prepare(`DELETE FROM metrics_hour WHERE ${tsCol} >= ?`).run(rolled).changes;
    } catch (e) { /* 表结构不符时保持 0 */ }
  }
  const catchUp = reset ? triggerFoldCatchUp() : 'not_needed';
  return [
    check('folding', reset ? 'warn' : 'ok', {
      watermark_before: Number.isFinite(rolledRaw) ? rolledRaw : null,
      watermark_after: rolled,
      min_ts: mm.mn,
      max_ts: mm.mx,
      reset,
      catch_up: catchUp
    }),
    check('overlap', overlapDeleted ? 'warn' : 'ok', { deleted: overlapDeleted, from: rolled })
  ];
}

// 5) 流量缺口：恢复后 traffic_state.last_ts 停在过去，下一条上报的
//    max(baseRx - last_rx, 0) 会把整段缺口的累计量一次性算进当月。
//    判定 max(3 × 实际上报间隔, 1h)，命中则重置基线（不计入 used_*）。
function checkTrafficGap(now) {
  if (!tableExists('traffic_state')) return check('traffic_gap', 'skipped', { reason: 'no_traffic_table' });
  let rows = [];
  try {
    rows = db.db.prepare('SELECT agent_id, last_ts FROM traffic_state').all();
  } catch (e) {
    return check('traffic_gap', 'skipped', { reason: e.message });
  }
  const fixed = [];
  for (const r of rows) {
    const last = Number(r.last_ts) || 0;
    if (!last) continue;
    let interval = null;
    try { interval = db.observedIntervalSec(r.agent_id); } catch (e) { /* 样本不足按默认阈值 */ }
    const limit = Math.max(3 * (Number(interval) || 0) * 1000, GAP_FLOOR_MS);
    if (now - last > limit) {
      try {
        db.markTrafficGap(r.agent_id, now);
        fixed.push({ agent_id: r.agent_id, gap_ms: now - last });
      } catch (e) { /* 单节点失败不影响其它节点 */ }
    }
  }
  return check('traffic_gap', fixed.length ? 'warn' : 'ok', {
    checked: rows.length,
    fixed: fixed.length,
    agents: fixed.slice(0, 10)
  });
}

// 6) 孤儿扫描：全库回滚后可能出现「指标还在、agent 行没了」的行。
//    表按存在性动态跳过（metrics_hour / online_sessions 可能尚未落地）。
const ORPHAN_TABLES = ['metrics', 'metrics_hour', 'traffic_state', 'alert_state', 'alert_overrides', 'online_sessions'];
function checkOrphans() {
  const per = {};
  let deleted = 0;
  for (const t of ORPHAN_TABLES) {
    if (!tableExists(t)) continue;
    if (!tableColumns(t).includes('agent_id')) continue;
    try {
      // 表名来自上方硬编码白名单，不含用户输入
      const n = db.db.prepare(`DELETE FROM ${t} WHERE agent_id NOT IN (SELECT id FROM agents)`).run().changes;
      per[t] = n;
      deleted += n;
    } catch (e) {
      per[t] = `error:${e.message}`;
    }
  }
  return check('orphans', deleted ? 'warn' : 'ok', { deleted, tables: per });
}

// 7) 软删过期：恢复回来的库里可能有早该物理清理的节点（F11 尚未落地时跳过）。
function checkSoftDeleted(now) {
  if (!tableColumns('agents').includes('deleted_at')) {
    return check('soft_deleted', 'skipped', { reason: 'soft_delete_not_enabled' });
  }
  let expired = 0;
  try {
    expired = db.db.prepare('SELECT COUNT(*) AS n FROM agents WHERE deleted_at IS NOT NULL AND deleted_at < ?')
      .get(now - SOFT_DELETE_GRACE_MS).n || 0;
  } catch (e) {
    return check('soft_deleted', 'skipped', { reason: e.message });
  }
  let purged = 0;
  try { purged = db.purgeDeletedAgents(now); } catch (e) { /* 清理失败不阻断启动，prune 还会重试 */ }
  return check('soft_deleted', purged ? 'warn' : 'ok', { expired, purged });
}

// 8) 容量水位（F12）：只评估 + 告警，绝不静默停写。
// 恢复回旧库后行数/文件大小可能已超阈值，这里立即刷新一次让保险丝生效。
function checkCapacity() {
  try {
    // 延迟 require：restore-audit 在启动早期加载，capacity 依赖 db 与 alerts
    const capacity = require('./capacity');
    const s = capacity.getStatus({ refresh: true });
    if (!s.enabled) return check('capacity', 'skipped', { reason: 'capacity_disabled' });
    return check('capacity', s.level === 'full' ? 'warn' : 'ok', {
      rows: s.rows,
      bytes: s.bytes,
      max_rows: s.max_rows,
      max_bytes: s.max_bytes,
      pct: s.pct,
      over: s.level === 'full'
    });
  } catch (e) {
    return check('capacity', 'skipped', { reason: e.message });
  }
}

function summarize(checks) {
  const out = { ok: 0, warn: 0, skipped: 0, fail: 0 };
  for (const c of checks) out[c.status] = (out[c.status] || 0) + 1;
  return out;
}

function checkValue(checks, id) {
  const c = checks.find((x) => x.id === id);
  return c && c.value ? c.value : {};
}

// 审查主流程。返回 { fatal, report }；无标记时返回 null。
// opts.now 便于测试注入固定时间。
function runRestoreAudit(opts = {}) {
  const now = Number(opts.now) || Date.now();
  const found = readPending();
  if (!found) return null;
  const { pending, source } = found;
  const startedAt = Date.now();
  const checks = [];
  let fatal = false;
  let error = '';

  try {
    const integrity = checkIntegrity();
    checks.push(integrity);
    fatal = integrity.status === 'fail';

    checks.push(checkRetention(now));
    checks.push(...checkFolding());
    checks.push(checkTrafficGap(now));
    checks.push(checkOrphans());
    checks.push(checkSoftDeleted(now));
    checks.push(checkCapacity());
  } catch (e) {
    error = e.message || String(e);
  }

  const summary = summarize(checks);
  const retention = checkValue(checks, 'retention');
  const orphans = checkValue(checks, 'orphans');
  const softDeleted = checkValue(checks, 'soft_deleted');
  const gap = checkValue(checks, 'traffic_gap');

  const report = {
    ts: now,
    backup: {
      name: String(pending.name || ''),
      ts: Number(pending.ts) || 0,
      // 备份文件自身时间（ms）；0 = 宿主未提供（老版本脚本/stat 失败）
      mtime: Number(pending.mtime) || 0,
      by: String(pending.by || '')
    },
    source,
    duration_ms: Date.now() - startedAt,
    retention_days: retention.retention_days || null,
    fatal,
    error,
    checks,
    summary: {
      ok: summary.ok || 0,
      warn: summary.warn || 0,
      skipped: summary.skipped || 0,
      fail: summary.fail || 0,
      total_rows: retention.total_rows || 0,
      expired_rows: retention.expired_rows || 0,
      orphan_deleted: orphans.deleted || 0,
      purged_agents: softDeleted.purged || 0,
      traffic_gap_fixed: gap.fixed || 0
    }
  };

  try { db.setRestoreAuditReport(report); } catch (e) { /* 只读/损坏库：报告丢失不影响审计 */ }

  // 审计必须写进恢复后的库（旧库里的 request_restore_backup 已被覆盖）。
  try {
    const detail = [
      `name=${report.backup.name || '(unknown)'}`,
      `result=${fatal ? 'fatal' : (error ? 'error' : 'ok')}`,
      `ok=${report.summary.ok}`,
      `warn=${report.summary.warn}`,
      `skipped=${report.summary.skipped}`,
      `fail=${report.summary.fail}`,
      `expired=${report.summary.expired_rows}/${report.summary.total_rows}`,
      `orphans=${report.summary.orphan_deleted}`,
      `purged=${report.summary.purged_agents}`,
      `gaps=${report.summary.traffic_gap_fixed}`
    ].join(' ');
    db.addAuditLog(now, report.backup.by || 'diting.sh', '', 'restore_completed', detail, 'script');
  } catch (e) { /* 审计失败不阻断启动 */ }

  // fatal 时保留标记：用户从 pre_restore_*.db 修好库后重启会再查一次。
  if (!fatal) {
    try { db.clearRestoreAuditPending(); } catch (e) { /* ignore */ }
    clearPendingFile();
  }
  return { fatal, report };
}

module.exports = {
  PENDING_FILE,
  RETENTION_WARN_RATIO,
  GAP_FLOOR_MS,
  runRestoreAudit,
  readPending,
  checkIntegrity,
  checkRetention,
  checkFolding,
  checkTrafficGap,
  checkOrphans,
  checkSoftDeleted,
  checkCapacity,
  triggerFoldCatchUp
};
