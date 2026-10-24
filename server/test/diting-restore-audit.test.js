'use strict';
// ============================================================
// F8.6 回归：diting.sh 侧的恢复审查标记
//
// 锚定行为：
//   1. 恢复前把 restore_audit_pending 写进「即将替换进库」的副本（不是原始备份）；
//   2. sqlite3 不可用时降级为备份可见目录标记文件；
//   3. 恢复结果（ok/failed/cancelled）回写 audit_logs（restore_backup）；
//   4. 后台请求文件里的 by（发起者）经 RESTORE_REQUESTED_BY 传入恢复流程。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
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

function bash(code, env) {
  return spawnSync('bash', ['-c', code], { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
}

test('恢复审查标记：payload 是合法 JSON，且过滤引号/换行', () => {
  const code = [
    'set -u',
    fnBody('_restore_pending_payload'),
    '_restore_pending_payload "$T_NAME" "$T_BY"',
  ].join('\n');
  const r = bash(code, {
    T_NAME: 'monitor_20260101_000000.db',
    T_BY: 'admin(session) 10.0.0.9',
  });
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.name, 'monitor_20260101_000000.db');
  assert.strictEqual(o.by, 'admin(session) 10.0.0.9');
  assert.ok(Number(o.ts) > 0, '应带毫秒时间戳');

  const evil = bash(code, {
    T_NAME: 'monitor_x.db"\'; DROP TABLE admin_config; --\n',
    T_BY: 'admin(session) 1.2.3.4\n\' OR 1=1 --',
  });
  const eo = JSON.parse(evil.stdout); // 过滤后必须仍是合法 JSON
  assert.ok(!/["';\n]/.test(eo.name), `文件名不应含引号/分号/换行: ${eo.name}`);
  assert.ok(!/[;\n]/.test(eo.by), `发起者不应含分号/换行: ${eo.by}`);
});

test('恢复审查标记：写入待替换库的 admin_config', (t) => {
  const probe = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('本机无 sqlite3'); return; }

  const dbFile = '/tmp/diting-restore-marker-test.db';
  for (const s of ['', '-journal']) {
    try { fs.unlinkSync(dbFile + s); } catch { /* ignore */ }
  }
  const init = spawnSync('sqlite3', [dbFile], {
    input: 'CREATE TABLE admin_config (key TEXT PRIMARY KEY, value TEXT);',
    encoding: 'utf8',
  });
  assert.strictEqual(init.status, 0);

  const payload = '{"name":"monitor_20260101_000000.db","ts":1,"by":"host(cli)"}';
  const code = [
    fnBody('_restore_mark_pending_db'),
    '_restore_mark_pending_db "$1" "$2"; echo "rc=$?"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', code, 'bash', dbFile, payload], { encoding: 'utf8' });
  assert.match(r.stdout, /rc=0/);

  const q = spawnSync('sqlite3', [dbFile, "SELECT value FROM admin_config WHERE key='restore_audit_pending'"], { encoding: 'utf8' });
  assert.strictEqual(q.stdout.trim(), payload, '标记应原样写入');
});

test('恢复审查标记：无 sqlite3 时降级写备份目录文件', () => {
  const dir = '/tmp/diting-restore-marker-dir';
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const code = [
    fnBody('_restore_write_pending_file'),
    'BACKUP_VISIBLE_DIR="$1"',
    '_restore_write_pending_file \'{"name":"monitor_x.db"}\'; echo "rc=$?"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', code, 'bash', dir], { encoding: 'utf8' });
  assert.match(r.stdout, /rc=0/);
  const file = path.join(dir, '.restore_audit_pending.json');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"name":"monitor_x.db"}');
});

test('恢复流程：发起者随请求文件传递，结果回写审计', () => {
  const req = fnBody('process_restore_request');
  assert.match(req, /RESTORE_REQUESTED_BY/, '应把请求文件里的 by 传给恢复流程');
  assert.match(req, /export RESTORE_REQUESTED_BY/);

  const wrapper = fnBody('do_restore');
  assert.match(wrapper, /_restore_apply/, 'do_restore 应是带审计的外层');
  assert.match(wrapper, /db_audit_log restore_backup/, '恢复结果应写进 audit_logs');
  assert.match(wrapper, /RESTORE_RESULT/, '应区分 ok/failed/cancelled');

  const apply = fnBody('_restore_apply');
  assert.match(apply, /_restore_mark_pending_db/, '替换前应写库内标记');
  assert.match(apply, /_restore_write_pending_file/, '写库失败应降级为文件标记');
  assert.match(apply, /cp "\$restore_src"/, '未压缩备份应复制后再写标记（不污染原始文件）');
});
