'use strict';
// ============================================================
// F8.1 应用内一致性快照回归
//
// 锚定行为（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md §5 F8.1 / F8.5）：
//   1. db.backupTo() 产物可打开，行数与源库一致；
//   2. POST /api/admin/backups 生成 monitor_* 快照（在线、不停服），
//      权限收紧为 0600，并写 create_backup 审计；
//   3. 未鉴权 401。
// ============================================================
process.env.DB_PATH = '/tmp/diting-backup-snapshot.db';
process.env.BACKUP_DIR = '/tmp/diting-backup-snapshot-dir';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* ignore */ }
}
fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true });
fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true });

const db = require('../src/db');

function seed() {
  const a = db.createAgent({ name: 'snapshot-agent' });
  const ins = db.db.prepare('INSERT INTO metrics (agent_id, ts) VALUES (?, ?)');
  ins.run(a.id, Date.now());
  ins.run(a.id, Date.now() - 1000);
  return a;
}

function counts(file) {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      agents: d.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
      metrics: d.prepare('SELECT COUNT(*) AS n FROM metrics').get().n
    };
  } finally {
    d.close();
  }
}

test('db.backupTo：产物可打开且行数一致', async () => {
  seed();
  const dest = path.join(process.env.BACKUP_DIR, 'monitor_20261010_101010.db');
  await db.backupTo(dest);
  assert.ok(fs.existsSync(dest));

  const src = counts(process.env.DB_PATH);
  const copy = counts(dest);
  assert.deepStrictEqual(copy, src, '快照行数应与源库一致');
  assert.ok(src.agents >= 1);
});

test('POST /api/admin/backups：生成快照、权限 0600、写审计；未鉴权 401', async () => {
  seed();
  process.env.PORT = '0';
  process.env.ADMIN_ALLOW_HTTP = '1';
  process.env.ADMIN_TOKEN = 'backup-snapshot-admin-token-0123456789';
  // eslint-disable-next-line global-require
  const { app, server } = require('../server');
  const request = require('supertest');
  try {
    const r = await request(app)
      .post('/api/admin/backups')
      .set({ 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.name, /^monitor_\d{8}_\d{6}\.db$/);
    assert.ok(r.body.size_bytes > 0);

    const file = path.join(process.env.BACKUP_DIR, r.body.name);
    assert.ok(fs.existsSync(file), '快照应落在备份目录');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, '备份含凭据，必须 0600');
    assert.deepStrictEqual(counts(file), counts(process.env.DB_PATH));

    const log = db.getAuditLogs(10, 0).find((l) => l.action === 'create_backup');
    assert.ok(log, '应写 create_backup 审计');
    assert.match(log.detail, new RegExp(`name=${r.body.name}`));

    const noAuth = await request(app).post('/api/admin/backups');
    assert.strictEqual(noAuth.status, 401);
  } finally {
    server.close();
    fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true });
  }
});
