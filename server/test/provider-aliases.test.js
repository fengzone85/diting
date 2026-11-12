'use strict';
// ============================================================
// 厂商别名注入：diting 的 merchant → 玻璃拟态设计 providerAliases
//
// 玻璃拟态设计的「厂商」不是后端字段，而是从 name/public_remark/remark/tags/group/region
// 做关键词匹配；diting 把 merchant 放进 tags，并把 merchant→display 映射换算成主题
// 的 `Provider:alias1,alias2;...` 字符串注入 theme_settings.providerAliases。
// ============================================================
process.env.DB_PATH = ':memory:';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 造一个声明了 providerAliases 配置项的临时主题（theme.js 在 require 时扫描 THEMES_DIR）
const THEMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-provider-alias-'));
process.env.THEMES_DIR = THEMES_DIR;
const themeDir = path.join(THEMES_DIR, 'fake-theme');
fs.mkdirSync(themeDir, { recursive: true });
fs.writeFileSync(path.join(themeDir, 'komari-theme.json'), JSON.stringify({
  short: 'fake-theme',
  name: 'Fake Theme',
  version: '1.0.0',
  configuration: {
    type: 'managed',
    data: [{ key: 'providerAliases', name: 'Provider aliases', type: 'string', default: '' }]
  }
}));

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const compat = require('../src/compat');

test('publicSettings：merchant 自动注入 providerAliases（含显式 display 映射）', () => {
  db.createAgent({ name: 'pa-a', merchant: '家里云' });
  db.createAgent({ name: 'pa-b', merchant: '搬瓦工' });
  db.setUiSettings(Object.assign({}, db.getUiSettings(), {
    public_theme: 'fake-theme',
    public_show_business: true,
    provider_aliases: { 家里云: 'HomeCloud' }
  }));

  const s = compat.publicSettings();
  assert.strictEqual(s.theme_settings.providerAliases, 'HomeCloud:家里云;搬瓦工:搬瓦工');
});

test('publicSettings：业务字段关闭时不注入商家名', () => {
  db.setUiSettings(Object.assign({}, db.getUiSettings(), { public_show_business: false }));
  const s = compat.publicSettings();
  assert.strictEqual(s.theme_settings.providerAliases, '');
});

test('cleanup：删除临时主题目录', () => {
  fs.rmSync(THEMES_DIR, { recursive: true, force: true });
});
