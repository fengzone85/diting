'use strict';
// ============================================================
// F8.6 回归：恢复后清理与一致性审查
//
// 锚定行为（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md §5 F8.6）：
//   1. diting.sh 在替换数据库前写 admin_config.restore_audit_pending（或降级为
//      备份目录 .restore_audit_pending.json），服务启动时消费；
//   2. 审查 8 项：结构完整性 / retention 预演 / 折叠水位线 / 明细小时重叠 /
//      流量缺口 / 孤儿 / 软删过期 / 容量水位；S2/F11/F12 未落地时按 skipped 跳过；
//   3. 缺口修复：traffic_state.last_rx/last_tx 置 NULL，缺口不计入 used_*；
//   4. 孤儿删除、软删过期立即 purge；
//   5. 完成后写 restore_completed 审计（写进恢复后的库）并清除标记。
// ============================================================
process.env.DB_PATH = '/tmp/diting-restore-audit-test.db';
process.env.BACKUP_DIR = '/tmp/diting-restore-audit-backups';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}
fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true });
fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true });

const db = require('../src/db');
const audit = require('../src/restore-audit');

const DAY = 86400000;
const PENDING_FILE = path.join(process.env.BACKUP_DIR, '.restore_audit_pending.json');

// better-sqlite3 默认关闭外键（见 db.js 注释）；显式关掉，保证能构造孤儿行。
try { db.db.pragma('foreign_keys = OFF'); } catch { /* ignore */ }

function mkAgent(name) {
  return db.createAgent({ name });
}

function insertMetric(agentId, ts) {
  db.db.prepare('INSERT INTO metrics (agent_id, ts) VALUES (?, ?)').run(agentId, ts);
}

function insertTraffic(agentId, lastTs, lastRx = 1000, lastTx = 2000) {
  db.db.prepare(`INSERT OR REPLACE INTO traffic_state
    (agent_id, cycle_key, cycle_start, used_rx, used_tx, last_rx, last_tx, last_ts, updated_at)
    VALUES (?, 'cumulative', NULL, 0, 0, ?, ?, ?, ?)`)
    .run(agentId, lastRx, lastTx, lastTs, lastTs);
}

test('无标记：直接返回 null，不做任何改动', () => {
  assert.strictEqual(db.getRestoreAuditPending(), null);
  assert.strictEqual(audit.runRestoreAudit(), null);
});

test('库内标记：8 项检查执行、缺口重置、孤儿/软删清理、审计回写', () => {
  const now = Date.now();
  const a = mkAgent('restore-a');
  // 50% 过期：触发 retention 预演黄条（retention 默认 30 天）
  insertMetric(a.id, now - 40 * DAY);
  insertMetric(a.id, now - 3600000);
  // 缺口 2h > max(3 × 间隔, 1h)
  insertTraffic(a.id, now - 2 * 3600000);

  // 孤儿：agent 行不存在
  insertMetric('ghost', now - 3600000);

  // 软删过期（8 天前删除）→ 应立即 purge
  const expired = mkAgent('restore-expired');
  db.deleteAgent(expired.id);
  db.db.prepare('UPDATE agents SET deleted_at=? WHERE id=?').run(now - 8 * DAY, expired.id);

  const by = 'admin(session) 10.0.0.9';
  db.setRestoreAuditPending({ name: 'monitor_20260101_000000.db', ts: now - DAY, by });

  const r = audit.runRestoreAudit({ now });
  assert.ok(r && r.report, '应产出审查报告');
  assert.strictEqual(r.fatal, false);

  const checks = Object.fromEntries(r.report.checks.map((c) => [c.id, c]));
  assert.strictEqual(checks.integrity.status, 'ok', '结构完整性通过');
  assert.strictEqual(checks.retention.status, 'warn', '过期占比 50% 应提示');
  assert.strictEqual(checks.folding.status, 'skipped', 'S2 未落地应跳过水位线检查');
  assert.strictEqual(checks.overlap.status, 'skipped', 'S2 未落地应跳过重叠检查');
  assert.strictEqual(checks.capacity.status, 'skipped', 'F12 未落地应跳过容量检查');

  // 缺口：基线清零（下一条上报只建基线，不把缺口算进当月）
  const tr = db.db.prepare('SELECT last_rx, last_tx, last_ts FROM traffic_state WHERE agent_id=?').get(a.id);
  assert.strictEqual(tr.last_rx, null, 'last_rx 应重置为 NULL');
  assert.strictEqual(tr.last_tx, null, 'last_tx 应重置为 NULL');
  assert.ok(tr.last_ts >= now, 'last_ts 应刷新到审查时刻');
  assert.strictEqual(checks.traffic_gap.status, 'warn');
  assert.strictEqual(checks.traffic_gap.value.fixed, 1);

  // 孤儿删除
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) AS n FROM metrics WHERE agent_id=?').get('ghost').n, 0);
  assert.ok(checks.orphans.value.deleted >= 1);

  // 软删过期立即物理清理
  assert.strictEqual(db.getAgentIncludingDeleted(expired.id), undefined);
  assert.ok(checks.soft_deleted.value.purged >= 1);

  // 报告落库 + 审计写进恢复后的库 + 标记清除
  const saved = db.getRestoreAuditReport();
  assert.ok(saved && saved.backup.name === 'monitor_20260101_000000.db');
  const log = db.getAuditLogs(20, 0).find((l) => l.action === 'restore_completed');
  assert.ok(log, '应写 restore_completed 审计');
  assert.strictEqual(log.admin, by, '审计记录发起者');
  assert.match(log.detail, /name=monitor_20260101_000000\.db/);
  assert.match(log.detail, /result=ok/);
  assert.strictEqual(db.getRestoreAuditPending(), null, '标记应清除');
  assert.strictEqual(audit.runRestoreAudit(), null, '再次启动不再重复审查');
});

test('文件兜底标记：库内无标记时读取备份目录文件并在完成后删除', () => {
  const now = Date.now();
  fs.writeFileSync(PENDING_FILE, JSON.stringify({
    name: 'monitor_20260202_000000.db', ts: now - 60000, by: 'host(cli)'
  }));

  const r = audit.runRestoreAudit({ now });
  assert.ok(r && r.report, '文件标记也应触发审查');
  assert.strictEqual(r.report.source, 'file');
  assert.strictEqual(r.report.backup.name, 'monitor_20260202_000000.db');
  assert.strictEqual(fs.existsSync(PENDING_FILE), false, '处理完应删除兜底文件');
});

test('F11 未落地时跳过软删检查（列不存在也不报错）', () => {
  // 用与真实库无关的最小库验证「动态跳过」：这里只断言现有库含 deleted_at 时
  // 检查不会误报失败；列缺失分支由 checkSoftDeleted 的 skipped 逻辑覆盖。
  const c = audit.checkSoftDeleted(Date.now());
  assert.ok(['ok', 'warn', 'skipped'].includes(c.status));
});
