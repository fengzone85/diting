'use strict';
// ============================================================
// S1/F2 收尾：通知配置迁移（独立化）
//
// 原「种子迁移」用例并入 notify.test.js 首节，与「组路由 / 模板 / 保序」等投放
// 行为混在一起；本文件把它独立出来，专测迁移这一件事：
//   1. 种子幂等：mail/telegram 内置渠道 + default 组绑定全部渠道；
//   2. GET /api/admin/notify/migration-status 的三种判定（无旧凭据 / 有旧凭据）；
//   3. 通知组路由处于启用态（对照组，与 notify-legacy-path.test.js 互斥验证）。
//
// 本文件**不设** NOTIFY_GROUPS —— 默认启用通知组路由。
// 旧直发路径的验证见 notify-legacy-path.test.js（该文件在独立进程中设
// NOTIFY_GROUPS=0，因为 notify.js 在 require 时读取该环境变量）。
// ============================================================

process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'notify-migration-admin-token-012345678';
process.env.DB_PATH = '/tmp/diting-notify-migration-test.db';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';
delete process.env.NOTIFY_GROUPS;

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const notify = require('../src/notify');

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };

after(async () => {
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// ---- 1. 种子迁移 ------------------------------------------------------------

test('种子幂等：mail/telegram 内置渠道 + default 组绑定全部渠道', () => {
  const channels = db.listNotifyChannels();
  const types = channels.map((c) => c.type).sort();
  assert.deepStrictEqual(types, ['mail', 'telegram']);

  const groups = db.listNotifyGroups();
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].name, 'default');
  assert.deepStrictEqual(groups[0].events, ['*']);
  assert.strictEqual(groups[0].channel_ids.length, 2);
});

test('种子幂等：重复执行不产生重复渠道 / 重复组', () => {
  db.initNotifyMigrationIfNeeded();
  db.initNotifyMigrationIfNeeded();
  assert.strictEqual(db.listNotifyChannels().length, 2);
  assert.strictEqual(db.listNotifyGroups().length, 1);
});

test('种子幂等：default 组被手动删除后重新种子化会恢复', () => {
  const g = db.listNotifyGroups().find((x) => x.name === 'default');
  if (g) db.deleteNotifyGroup(g.id);
  assert.strictEqual(db.listNotifyGroups().filter((x) => x.name === 'default').length, 0);
  db.initNotifyMigrationIfNeeded();
  const restored = db.listNotifyGroups().filter((x) => x.name === 'default');
  assert.strictEqual(restored.length, 1);
  assert.deepStrictEqual(restored[0].events, ['*']);
});

// ---- 2. 迁移状态端点 --------------------------------------------------------

test('迁移状态：无旧凭据时 banner=false', async () => {
  db.setConfig('notify_config', JSON.stringify({ smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: '' }));
  const res = await request(app).get('/api/admin/notify/migration-status').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.legacy_config_present, false);
  assert.strictEqual(res.body.banner, false);
  assert.strictEqual(res.body.groups_enabled, true, '本文件未设 NOTIFY_GROUPS，应为启用态');
});

test('迁移状态：旧凭据 + default 组 → banner=true', async () => {
  // 旧版凭据格式：notify_config 里带 smtp/telegram 配置
  db.setConfig('notify_config', JSON.stringify({
    smtp_user: 'u@example.com', smtp_pass: 'p', telegram_bot_token: 't', telegram_chat_id: 'c',
  }));
  const res = await request(app).get('/api/admin/notify/migration-status').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.legacy_config_present, true);
  assert.strictEqual(res.body.default_group_present, true);
  assert.strictEqual(res.body.banner, true, '旧凭据 + default 组 ⇒ 应提示迁移横幅');
  // 还原，避免影响其它用例
  db.setConfig('notify_config', JSON.stringify({ smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: '' }));
});

test('迁移状态：未认证请求被拒（401）', async () => {
  const res = await request(app).get('/api/admin/notify/migration-status');
  assert.strictEqual(res.status, 401);
});

// ---- 3. 通知组路由启用态（对照组） ------------------------------------------

test('通知组路由启用（默认）：groupsEnabled()=true', () => {
  assert.strictEqual(notify.groupsEnabled(), true);
});
