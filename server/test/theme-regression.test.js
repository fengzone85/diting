'use strict';
// ============================================================
// S5/F10 回归：历史兼容契约不得被后续改动悄悄击穿
// - 干净安装下 themeNonceSet 为空（发布包无主题需要 nonce）
// - 构造 needsRelaxedCsp 主题 → 被纳入集合；删除 → 被移除
// - 内置 manifest.json 主题继续可用（保留 id 字段、name 已归一化为字符串）
// - /api/public/themes 继续返回 {id, name, ...}[] 兼容旧 SettingsView 下拉
// - ui_settings.public_theme 字段保持不变
// ============================================================
process.env.DB_PATH = '/tmp/diting-theme-reg.db';
process.env.THEMES_DIR = '/tmp/diting-theme-reg/themes';
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'reg-admin-token-0123456789abcdef';
process.env.READONLY_TOKEN = 'reg-readonly-token-0123456789abcdef';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DB = process.env.DB_PATH;
const ROOT = process.env.THEMES_DIR;
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(DB + suffix); } catch { /* 忽略 */ }
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const supertest = require('supertest');
const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const ai = require('../src/ai');
const theme = require('../src/theme');

after(async () => {
  alerts.stop();
  ai.stop();
  try { server.closeAllConnections?.(); } catch {}
  try { await new Promise((r) => server.close(r)); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch {}
  }
});

// ---- 1. 发布包兼容契约 ------------------------------------------------------

test('themeNonceSet：干净安装为空（发布包 komari-demo / neobrutalism 无 needsRelaxedCsp）', () => {
  theme.rebuildNonceSet();
  const s = theme.themeNonceSet;
  assert.strictEqual(s.size, 0, '发布包内无主题应声明 needsRelaxedCsp');
  assert.strictEqual(theme.resolveThemeDir('komari-demo').bundled, true);
  assert.strictEqual(theme.resolveThemeDir('neobrutalism').bundled, true);
});

test('themeNonceSet：needsRelaxedCsp=true 主题被纳入，删除后移除', () => {
  const dir = path.join(theme.INSTALLED_THEMES_DIR, 'reg-relax');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'diting-theme.json'), JSON.stringify({
    short: 'reg-relax', name: { zh_CN: '回归', en: 'Reg' }, version: '1.0.0',
    diting: { needsRelaxedCsp: true }
  }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');

  theme.rebuildNonceSet();
  assert.strictEqual(theme.themeNonceSet.has('reg-relax'), true);

  fs.rmSync(dir, { recursive: true, force: true });
  theme.rebuildNonceSet();
  assert.strictEqual(theme.themeNonceSet.has('reg-relax'), false);
});

test('ui_settings.public_theme 字段保持不变（启用流程走同一字段）', () => {
  const ui = db.getUiSettings();
  assert.ok(ui && typeof ui.public_theme === 'string');
  const enabled = theme.listInstalledThemes().find((x) => x.short === 'neobrutalism');
  if (enabled && theme.hasIndexHtml('neobrutalism')) {
    theme.setEnabled('neobrutalism');
    assert.strictEqual(db.getUiSettings().public_theme, 'neobrutalism');
    theme.setEnabled('default');
    assert.strictEqual(db.getUiSettings().public_theme, 'default');
  }
});

// ---- 2. 公开接口契约 ---------------------------------------------------------

test('GET /api/public/themes：保留 id 字段（= short），name/description 归一化为字符串', async () => {
  const res = await supertest(app).get('/api/public/themes');
  assert.strictEqual(res.status, 200);
  const list = res.body;
  assert.ok(Array.isArray(list));

  // 老 manifest.json 主题（如 komari-demo）必须带 id 字段（= short）
  assert.ok(list.some((t) => t.id !== undefined), '至少有主题返回 id 字段');

  const demo = list.find((t) => t.id === 'komari-demo');
  assert.ok(demo);
  assert.strictEqual(typeof demo.name, 'string');
  assert.strictEqual(typeof demo.description, 'string');
  assert.ok(demo.name.length > 0);
});

test('GET /api/public/themes：不门控（public_enabled 关闭仍能返回列表）', async () => {
  const ui = db.getUiSettings();
  db.setUiSettings({ ...ui, public_enabled: false });
  const res = await supertest(app).get('/api/public/themes');
  assert.strictEqual(res.status, 200);
  db.setUiSettings({ ...db.getUiSettings(), public_enabled: true });
});
