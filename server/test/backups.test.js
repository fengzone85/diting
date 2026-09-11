// 备份文件管理单测：命名白名单、列表过滤、删除、恢复请求投递。
// 关键安全属性：任何目录穿越/任意文件名都必须被 resolveBackupFile 拒绝。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 必须在 require 之前设好，模块在加载时读取环境变量
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-bk-'));
process.env.BACKUP_DIR = DIR;
process.env.RESTORE_TRIGGER = path.join(DIR, 'restore.request');

const backups = require('../src/backups');

function makeFile(name, content = 'SQLite format 3\u0000abc') {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

test.after(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

test('resolveBackupFile: 接受合法命名，拒绝穿越与任意文件', () => {
  assert.ok(backups.resolveBackupFile('monitor_20260911_031500.db'));
  assert.ok(backups.resolveBackupFile('monitor_20260911_031500.db.gz'));
  assert.ok(backups.resolveBackupFile('pre_restore_20260911_031500.db'));

  // 目录穿越
  assert.strictEqual(backups.resolveBackupFile('../monitor_20260911_031500.db'), null);
  assert.strictEqual(backups.resolveBackupFile('..%2Fmonitor_20260911_031500.db'), null);
  assert.strictEqual(backups.resolveBackupFile('/etc/passwd'), null);
  assert.strictEqual(backups.resolveBackupFile('sub/monitor_20260911_031500.db'), null);
  // 命名不合法（可能是人工放进目录的其它文件）
  assert.strictEqual(backups.resolveBackupFile('monitor.db'), null);
  assert.strictEqual(backups.resolveBackupFile('backup.log'), null);
  assert.strictEqual(backups.resolveBackupFile('monitor_2026_0315.db'), null);
  assert.strictEqual(backups.resolveBackupFile(''), null);
  assert.strictEqual(backups.resolveBackupFile(null), null);
  assert.strictEqual(backups.resolveBackupFile(undefined), null);
});

test('listBackups: 只列合法备份，忽略日志等其它文件，新的在前', () => {
  fs.readdirSync(DIR).forEach((f) => fs.unlinkSync(path.join(DIR, f)));
  makeFile('monitor_20260909_031500.db');
  makeFile('monitor_20260911_031500.db.gz');
  makeFile('pre_restore_20260910_031500.db');
  makeFile('backup.log', 'not a backup');
  makeFile('restore.request', '{}');

  const list = backups.listBackups();
  assert.strictEqual(list.length, 3, '应只列出 3 个备份，日志/请求文件不算');
  const names = list.map((f) => f.name);
  assert.ok(!names.includes('backup.log'));
  assert.ok(!names.includes('restore.request'));

  const gz = list.find((f) => f.name.endsWith('.gz'));
  assert.strictEqual(gz.compressed, true);
  const pre = list.find((f) => f.name.startsWith('pre_restore_'));
  assert.strictEqual(pre.kind, 'pre_restore');
  const mon = list.find((f) => f.name === 'monitor_20260909_031500.db');
  assert.strictEqual(mon.kind, 'monitor');
});

test('backupSummary: 统计总数与占用', () => {
  const s = backups.backupSummary();
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.monitor_count, 2, 'pre_restore 不计入 monitor_count');
  assert.ok(s.total_bytes > 0);
  assert.strictEqual(s.dir, DIR);
});

test('inspectFile: 识别 SQLite 与 gzip，拒绝垃圾内容', () => {
  const dbFile = makeFile('monitor_20260912_031500.db');
  assert.strictEqual(backups.inspectFile(dbFile, path.basename(dbFile)).ok, true);

  // gzip 魔数 1f 8b
  const gzName = 'monitor_20260912_031501.db.gz';
  const gzFile = path.join(DIR, gzName);
  fs.writeFileSync(gzFile, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.strictEqual(backups.inspectFile(gzFile, gzName).ok, true);

  const junk = makeFile('monitor_20260912_031502.db', 'this is not a database');
  const r = backups.inspectFile(junk, path.basename(junk));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not a sqlite database');
});

test('deleteBackup: 删除合法文件；非法名与不存在分别返回 400/404', () => {
  const name = 'monitor_20260913_031500.db';
  makeFile(name);
  assert.strictEqual(backups.deleteBackup(name).ok, true);
  assert.strictEqual(fs.existsSync(path.join(DIR, name)), false);

  const again = backups.deleteBackup(name);
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, 404);

  const bad = backups.deleteBackup('../etc/passwd');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 400);
});

test('requestRestore: 校验文件后写请求；垃圾文件与非法名被拒', () => {
  const name = 'monitor_20260914_031500.db';
  makeFile(name);
  const r = backups.requestRestore(name);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, name);
  assert.ok(fs.existsSync(backups.RESTORE_TRIGGER));

  const req = backups.readRestoreRequest();
  assert.strictEqual(req.name, name);
  assert.ok(req.file.endsWith(name));

  assert.strictEqual(backups.clearRestoreRequest(), true);
  assert.strictEqual(backups.readRestoreRequest(), null);
});

test('requestRestore: 非数据库内容与非法命名均拒绝，且不写请求文件', () => {
  const junk = 'monitor_20260915_031500.db';
  makeFile(junk, 'garbage');
  const r1 = backups.requestRestore(junk);
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.code, 400);

  const r2 = backups.requestRestore('../etc/passwd');
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.code, 400);
  assert.strictEqual(fs.existsSync(backups.RESTORE_TRIGGER), false);
});
