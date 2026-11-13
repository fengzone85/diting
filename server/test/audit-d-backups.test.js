'use strict';
// ============================================================
// 外部审查复核 Batch D：D3 RESTORE_TRIGGER 原子写（tmp+rename）。
// 负向对照：git show HEAD:server/src/backups.js 旧版跑本文件应失败
// （模拟写中途崩溃时旧版留下半截 trigger，新版保持上一份完整请求）。
// ============================================================
const path = require('node:path');
const DIR = '/tmp/diting-audit-d-backups';
process.env.BACKUP_DIR = DIR;
process.env.RESTORE_TRIGGER = path.join(DIR, 'restore.request');

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const Database = require('better-sqlite3');

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const backups = require('../src/backups');

function makeBackup(name) {
  const d = new Database(path.join(DIR, name));
  d.exec('CREATE TABLE t (x INTEGER)');
  d.close();
  return name;
}

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('D3 恢复触发冒烟：trigger 完整可读、0600、无 tmp 残留', () => {
  const name = makeBackup('monitor_20260101_000000.db');
  const r = backups.requestRestore(name, 'tester');
  assert.strictEqual(r.ok, true, r.error);
  const raw = fs.readFileSync(backups.RESTORE_TRIGGER, 'utf8');
  const payload = JSON.parse(raw);
  assert.strictEqual(payload.name, name);
  assert.strictEqual(payload.by, 'tester');
  assert.strictEqual(payload.file, path.join(DIR, name));
  assert.strictEqual(fs.statSync(backups.RESTORE_TRIGGER).mode & 0o777, 0o600);
  assert.deepStrictEqual(backups.readRestoreRequest(), payload);
  assert.deepStrictEqual(fs.readdirSync(DIR).filter((n) => n.includes('.tmp-')), []);
});

test('D3 写中途崩溃：trigger 不被半截 JSON 污染，tmp 清理', () => {
  const name1 = 'monitor_20260101_000000.db';
  const before = fs.readFileSync(backups.RESTORE_TRIGGER, 'utf8');
  const name2 = makeBackup('monitor_20260101_000001.db');

  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (p, data, opts) => {
    if (String(p).startsWith(backups.RESTORE_TRIGGER)) {
      realWrite(p, String(data).slice(0, 5), opts); // 半截后崩溃
      throw Object.assign(new Error('ENOSPC: simulated mid-write crash'), { code: 'ENOSPC' });
    }
    return realWrite(p, data, opts);
  };
  let r;
  try {
    r = backups.requestRestore(name2, 'tester');
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 500);
  assert.strictEqual(fs.readFileSync(backups.RESTORE_TRIGGER, 'utf8'), before, '上一份完整请求应原样保留');
  assert.deepStrictEqual(fs.readdirSync(DIR).filter((n) => n.includes('.tmp-')), [], 'tmp 应被清理');

  const r3 = backups.requestRestore(name2, 'tester');
  assert.strictEqual(r3.ok, true, '故障后应可再次发起恢复');
  assert.strictEqual(backups.readRestoreRequest().name, name2);
});