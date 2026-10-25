'use strict';
// ============================================================
// F8.3 完整性预检回归
//
// 锚定行为（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md §5 F8.3）：
//   1. 备份列表附 integrity: 'ok' | 'fail' | 'unknown'；
//   2. 恢复前对选中备份做 SQLite 头魔数 + PRAGMA integrity_check（只读、限 10s）；
//   3. 校验失败拒绝恢复（400）并提示，且不写恢复请求文件；
//   4. gzip 备份无法就地检查 → unknown，放行（解压后的校验在 diting.sh 里）。
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-bk-integrity-'));
process.env.BACKUP_DIR = DIR;
process.env.RESTORE_TRIGGER = path.join(DIR, 'restore.request');

const backups = require('../src/backups');

function resetDir() {
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { force: true });
}

function makeDb(name, rows = 1) {
  const p = path.join(DIR, name);
  const d = new Database(p);
  d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = d.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < rows; i++) ins.run(`row-${i}`);
  d.close();
  return p;
}

test.after(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

test('合法库：deep integrity_check 通过，列表标 ok', () => {
  resetDir();
  const name = 'monitor_20261001_000000.db';
  makeDb(name, 20);

  assert.strictEqual(backups.inspectIntegrity(path.join(DIR, name), name, { deep: true }).status, 'ok');
  const item = backups.listBackups().find((f) => f.name === name);
  assert.ok(item, '应出现在列表');
  assert.strictEqual(item.integrity, 'ok');
});

test('损坏库：integrity_check 失败，列表标 fail，恢复被拒且不写请求文件', () => {
  resetDir();
  const name = 'monitor_20261002_000000.db';
  const p = makeDb(name, 2000);
  // 保留 SQLite 头（魔数/页大小），破坏第 1 页的 schema 记录。
  // 只读打开仍能通过 inspectFile（魔数），但 PRAGMA 会失败。
  const buf = fs.readFileSync(p);
  buf.fill(0xab, 100, Math.min(buf.length, 4096));
  fs.writeFileSync(p, buf);

  assert.strictEqual(backups.inspectFile(p, name).ok, true, '魔数仍合法');
  const deep = backups.inspectIntegrity(p, name, { deep: true });
  assert.strictEqual(deep.status, 'fail', `损坏库应失败：${deep.reason || ''}`);

  const item = backups.listBackups().find((f) => f.name === name);
  assert.strictEqual(item.integrity, 'fail');

  const r = backups.requestRestore(name);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 400);
  assert.match(r.error, /integrity check failed/);
  assert.strictEqual(fs.existsSync(backups.RESTORE_TRIGGER), false, '失败的恢复不应留下请求文件');
});

test('gzip 备份：无法就地检查 → unknown，恢复放行（由脚本解压后校验）', () => {
  resetDir();
  const name = 'monitor_20261003_000000.db.gz';
  const p = path.join(DIR, name);
  fs.writeFileSync(p, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));

  const integ = backups.inspectIntegrity(p, name, { deep: true });
  assert.strictEqual(integ.status, 'unknown');

  const item = backups.listBackups().find((f) => f.name === name);
  assert.strictEqual(item.integrity, 'unknown');

  const r = backups.requestRestore(name);
  assert.strictEqual(r.ok, true, 'gzip 备份应允许恢复');
  assert.strictEqual(backups.readRestoreRequest().name, name);
  backups.clearRestoreRequest();
});
