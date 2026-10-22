'use strict';
// 上传备份端点：把外部备份放进 BACKUP_DIR，之后走既有的「恢复」流程。
//
// 安全边界（本文件逐条断言）：
//   ① 需要管理端凭据（adminOnly）
//   ② 只认 SQLite 头 / gzip 魔数，其它内容 400 —— 不当公共文件暂存盘
//   ③ 文件名由服务端生成，客户端给的名字整个丢弃（无穿越、不破坏 NAME_RE 白名单）
//   ④ 超限 413（BACKUP_UPLOAD_MAX_MB）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-upload-'));
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.DB_PATH = path.join(TMP, 'monitor.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_UPLOAD_MAX_MB = '1';           // 测试用 1MB 上限
process.env.ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';

const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, server } = require('../server');
const backups = require('../src/backups');

const PROTO = { 'X-Forwarded-Proto': 'https' };
const AUTH = { ...PROTO, 'X-Admin-Token': process.env.ADMIN_TOKEN };
const SQLITE_HEAD = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(64, 1)]);
const GZIP_HEAD = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(64, 2)]);

after(async () => {
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('上传：无凭据 → 401', async () => {
  const res = await request(app).post('/api/admin/backups/upload')
    .set(PROTO).set('Content-Type', 'application/octet-stream').send(SQLITE_HEAD);
  assert.strictEqual(res.status, 401);
});

test('上传：非 SQLite/gzip 内容 → 400（不当文件暂存盘）', async () => {
  const res = await request(app).post('/api/admin/backups/upload')
    .set(AUTH).set('Content-Type', 'application/octet-stream').send(Buffer.from('hello world, not a database'));
  assert.strictEqual(res.status, 400);
  assert.match(String(res.body.error), /not a sqlite database/);
});

test('上传：SQLite 文件 → 服务端生成规范文件名、600 权限、出现在列表里', async () => {
  const res = await request(app).post('/api/admin/backups/upload')
    .set(AUTH).set('Content-Type', 'application/octet-stream')
    .set('X-Backup-Name', '../../etc/passwd')   // 客户端名字必须被忽略
    .send(SQLITE_HEAD);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.name, backups.NAME_RE, '名字必须符合白名单正则');
  assert.ok(res.body.name.startsWith('monitor_'), '应由服务端生成 monitor_ 前缀');
  assert.ok(!res.body.name.includes('..'), '不得包含客户端给的路径');

  const full = path.join(backups.BACKUP_DIR, res.body.name);
  const st = fs.statSync(full);
  assert.strictEqual(st.mode & 0o777, 0o600, '备份文件应为 600');
  assert.strictEqual(st.size, SQLITE_HEAD.length);

  const list = backups.listBackups();
  assert.ok(list.some((f) => f.name === res.body.name), '列表应能列出刚上传的文件');
  assert.strictEqual(list.find((f) => f.name === res.body.name).kind, 'monitor');
});

test('上传：gzip 内容 → .db.gz 结尾且 compressed=true', async () => {
  const res = await request(app).post('/api/admin/backups/upload')
    .set(AUTH).set('Content-Type', 'application/octet-stream').send(GZIP_HEAD);
  // 同一秒内重复上传可能撞名 → 409，重试一次即可（真实场景时间戳秒级唯一）
  const name = res.status === 409
    ? (await new Promise((r) => setTimeout(r, 1100)) || await request(app).post('/api/admin/backups/upload')
      .set(AUTH).set('Content-Type', 'application/octet-stream').send(GZIP_HEAD)).body.name
    : res.body.name;
  assert.match(name, /\.db\.gz$/, `应以 .db.gz 结尾，实际 ${name}`);
  const item = backups.listBackups().find((f) => f.name === name);
  assert.ok(item && item.compressed === true);
});

test('上传：超过 BACKUP_UPLOAD_MAX_MB → 413 并给出可调项', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 1);
  SQLITE_HEAD.copy(big, 0);
  const res = await request(app).post('/api/admin/backups/upload')
    .set(AUTH).set('Content-Type', 'application/octet-stream').send(big);
  assert.strictEqual(res.status, 413);
  assert.strictEqual(res.body.error, 'too_large');
  assert.match(String(res.body.message), /BACKUP_UPLOAD_MAX_MB/);
});

test('上传：空 body → 400', async () => {
  const res = await request(app).post('/api/admin/backups/upload')
    .set(AUTH).set('Content-Type', 'application/octet-stream');
  assert.strictEqual(res.status, 400);
});
