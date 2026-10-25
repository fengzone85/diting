'use strict';
// ============================================================
// F8.4 回归：备份保留份数（BACKUP_KEEP，默认 10）
//
// 锚定行为（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md §5 F8.4）：
//   1. 按 mtime 清理最旧的 monitor_*（含 .db.gz），保留最新 N 份；
//   2. 正好 N 份时不删；N+1 份时只删最旧 1 份；
//   3. 0 = 不限；
//   4. pre_restore_* 是恢复回滚点，永远不参与清理。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'diting.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

function fnBody(name) {
  const start = src.indexOf(`${name}() {`);
  assert.notStrictEqual(start, -1, `diting.sh 应包含 ${name}() 定义`);
  const end = src.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `未能定位 ${name}() 的函数体结尾`);
  return src.slice(start, end + 3);
}

function runPrune(dir, keep) {
  const code = [
    'set -u',
    'YELLOW=""; GREEN=""; NC=""',
    'msg() { printf \'%s\' "$1"; }',
    'DB_BACKUP_DIR="$1"',
    'DB_BACKUP_KEEP_COUNT=10',
    fnBody('prune_backups_count'),
    'prune_backups_count "$2"',
  ].join('\n');
  return spawnSync('bash', ['-c', code, 'bash', dir, String(keep)], { encoding: 'utf8' });
}

function resetDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-keep-count-'));
  return dir;
}

function touch(dir, name, stamp) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  const r = spawnSync('touch', ['-t', stamp, p], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

test('N+1 份：只删最旧一份，最新 N 份保留', () => {
  const dir = resetDir();
  touch(dir, 'monitor_20261001_000000.db', '202610010000');
  touch(dir, 'monitor_20261002_000000.db', '202610020000');
  touch(dir, 'monitor_20261003_000000.db', '202610030000');
  touch(dir, 'monitor_20261004_000000.db', '202610040000');
  touch(dir, 'pre_restore_20261001_000000.db', '202610010000');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'keep me');

  const r = runPrune(dir, 3);
  assert.strictEqual(r.status, 0, r.stderr);

  const left = fs.readdirSync(dir).filter((f) => f.startsWith('monitor_')).sort();
  assert.deepStrictEqual(left, [
    'monitor_20261002_000000.db',
    'monitor_20261003_000000.db',
    'monitor_20261004_000000.db',
  ]);
  assert.ok(fs.existsSync(path.join(dir, 'pre_restore_20261001_000000.db')), 'pre_restore 不能被清');
  assert.ok(fs.existsSync(path.join(dir, 'note.txt')), '非备份文件不能被清');
  assert.match(r.stdout, /monitor_20261001_000000\.db/, '日志应列出被清文件');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('正好 N 份：不删除', () => {
  const dir = resetDir();
  touch(dir, 'monitor_20261001_000000.db', '202610010000');
  touch(dir, 'monitor_20261002_000000.db', '202610020000');
  touch(dir, 'monitor_20261003_000000.db', '202610030000');

  const r = runPrune(dir, 3);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('monitor_')).length, 3);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('0 = 不限：不删除任何备份', () => {
  const dir = resetDir();
  for (let i = 1; i <= 5; i++) {
    touch(dir, `monitor_2026100${i}_000000.db`, `2026100${i}0000`);
  }
  const r = runPrune(dir, 0);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('monitor_')).length, 5);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('压缩产物（.db.gz）同样计数', () => {
  const dir = resetDir();
  touch(dir, 'monitor_20261001_000000.db.gz', '202610010000');
  touch(dir, 'monitor_20261002_000000.db.gz', '202610020000');
  touch(dir, 'monitor_20261003_000000.db', '202610030000');

  const r = runPrune(dir, 2);
  assert.strictEqual(r.status, 0, r.stderr);
  const left = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(left, ['monitor_20261002_000000.db.gz', 'monitor_20261003_000000.db']);

  fs.rmSync(dir, { recursive: true, force: true });
});
