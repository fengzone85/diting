'use strict';
// ============================================================
// S5/F10：主题市场（catalog 解析 / 缓存 / 安装 / 导入 / 更新 / 回滚）
// 使用本地 HTTP 服务器模拟市场源；放行明文 http 与私网（仅测试环境）。
// ============================================================
process.env.DB_PATH = '/tmp/diting-theme-market.db';
process.env.THEMES_DIR = '/tmp/diting-theme-market/themes';
process.env.ALLOW_INSECURE_WEBHOOK = '1';
process.env.ALLOW_PRIVATE_WEBHOOK = '1';

const { test, after, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const DB = process.env.DB_PATH;
const ROOT = '/tmp/diting-theme-market';
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(DB + suffix); } catch { /* 忽略 */ }
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const db = require('../src/db');
const theme = require('../src/theme');
const market = require('../src/theme-market');

// 测试隔离：官方源种子默认启用，会发起真实网络请求；本文件只用本地模拟源
db.deleteThemeMarketSource('official');

// ---- 本地市场源 -------------------------------------------------------------
const routes = new Map(); // path -> { body, type, hits }
const hits = new Map();
const server = http.createServer((req, res) => {
  hits.set(req.url, (hits.get(req.url) || 0) + 1);
  const r = routes.get(req.url);
  if (!r) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', r.type || 'application/json; charset=utf-8');
  res.end(r.body);
});
let BASE = '';

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch { /* 忽略 */ }
  }
});

function serve(p, body, type) {
  routes.set(p, { body, type });
}
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function makeZip(manifest, extra = {}) {
  const zip = new AdmZip();
  zip.addFile('diting-theme.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('index.html', Buffer.from('<!doctype html><html><body>ok</body></html>'));
  for (const [name, data] of Object.entries(extra)) zip.addFile(name, Buffer.from(data));
  return zip.toBuffer();
}
const manifest = (short, version, extra = {}) => ({
  short, name: `Theme ${short}`, version, ...extra
});

// ---- 1. catalog 解析 --------------------------------------------------------

test('parseCatalog：schema wrapper / 数组 / 单对象三种形态', () => {
  const src = { id: 's1', name: 'Local', url: 'https://example.com/market/v1.json' };
  const wrapped = market.parseCatalog({ themes: [{ short: 'aa', name: { zh_CN: '甲', en: 'A' }, download: 'a.zip', preview: 'img/a.png', sha256: 'A'.repeat(64) }] }, src);
  assert.strictEqual(wrapped.length, 1);
  assert.strictEqual(wrapped[0].name, '甲');
  assert.strictEqual(wrapped[0].sha256, 'a'.repeat(64), 'sha256 应归一化为小写');
  assert.strictEqual(wrapped[0].installable, true);
  assert.strictEqual(wrapped[0].source_id, 's1');
  assert.strictEqual(wrapped[0].download, 'https://example.com/market/a.zip', '相对 download 应解析为绝对地址');
  assert.strictEqual(wrapped[0].preview, 'https://example.com/market/img/a.png', '相对 preview 应解析为绝对地址');

  const arr = market.parseCatalog([{ short: 'bb', name: 'B' }], src);
  assert.strictEqual(arr.length, 1);
  assert.strictEqual(arr[0].installable, false, '缺少 download/sha256 不可安装');

  const single = market.parseCatalog({ id: 'cc', name: 'C' }, src);
  assert.strictEqual(single.length, 1);
  assert.strictEqual(single[0].short, 'cc');

  assert.deepStrictEqual(market.parseCatalog(null, src), []);
});

test('parseCatalog：skip 非法 short 与 installable:false', () => {
  const src = { id: 's', name: 'S' };
  const out = market.parseCatalog([
    { short: '../evil', name: 'E' },
    { short: 'ok', name: 'O', download: 'https://x/o.zip', sha256: 'b'.repeat(64), installable: false }
  ], src);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].installable, false);
});

// ---- 2. 缓存 -----------------------------------------------------------------

test('fetchCatalog：10 分钟内复用缓存，force 跳过，invalidate 后重取', async () => {
  const body = JSON.stringify({ themes: [{ short: 'cache-t', name: 'C', download: `${BASE}/c.zip`, sha256: 'c'.repeat(64) }] });
  serve('/catalog-cache.json', body);
  const src = db.createThemeMarketSource({ name: 'cache', url: `${BASE}/catalog-cache.json` });

  await market.fetchCatalog(src);
  await market.fetchCatalog(src);
  assert.strictEqual(hits.get('/catalog-cache.json'), 1, '第二次应命中缓存');

  await market.fetchCatalog(src, true);
  assert.strictEqual(hits.get('/catalog-cache.json'), 2, 'force 应重新拉取');

  market.invalidateCatalog(src.url);
  await market.fetchCatalog(src);
  assert.strictEqual(hits.get('/catalog-cache.json'), 3, '失效后应重新拉取');
});

test('listMarketThemes：部分源失败不拖垮其它源', async () => {
  db.deleteThemeMarketSource('bad-src');
  const good = db.createThemeMarketSource({ name: 'good', url: `${BASE}/catalog-cache.json` });
  const bad = db.createThemeMarketSource({ name: 'bad', url: 'http://127.0.0.1:1/catalog.json' });
  const result = await market.listMarketThemes(true);
  assert.ok(result.themes.some((t) => t.source_id === good.id));
  assert.strictEqual(result.errors.length, 1);
  assert.strictEqual(result.errors[0].source_id, bad.id);
  db.deleteThemeMarketSource(bad.id);
});

// ---- 3. 安装 -----------------------------------------------------------------

test('installFromMarket：完整链路（下载 → SHA256 → 解压 → manifest 比对）', async () => {
  const zip = makeZip(manifest('mk-happy', '1.0.0'));
  serve('/mk-happy.zip', zip, 'application/zip');
  const catalog = JSON.stringify({
    themes: [{ short: 'mk-happy', name: 'Happy', version: '1.0.0', download: `${BASE}/mk-happy.zip`, sha256: sha(zip) }]
  });
  serve('/catalog-install.json', catalog);
  const src = db.createThemeMarketSource({ name: 'install', url: `${BASE}/catalog-install.json` });

  const m = await market.installFromMarket(src.id, 'mk-happy');
  assert.strictEqual(m.short, 'mk-happy');
  assert.strictEqual(m.version, '1.0.0');
  assert.ok(fs.existsSync(path.join(theme.INSTALLED_THEMES_DIR, 'mk-happy', 'index.html')));
  assert.ok(theme.listInstalledThemes().some((t) => t.short === 'mk-happy'));
});

test('installFromMarket：SHA256 不匹配 / catalog 版本不匹配 / 主题不存在', async () => {
  const zip = makeZip(manifest('mk-sha', '1.0.0'));
  serve('/mk-sha.zip', zip, 'application/zip');

  serve('/catalog-sha.json', JSON.stringify({
    themes: [{ short: 'mk-sha', version: '1.0.0', download: `${BASE}/mk-sha.zip`, sha256: 'd'.repeat(64) }]
  }));
  const s1 = db.createThemeMarketSource({ name: 'sha', url: `${BASE}/catalog-sha.json` });
  await assert.rejects(() => market.installFromMarket(s1.id, 'mk-sha'), (e) => e.code === 'theme_sha256_mismatch');

  serve('/catalog-ver.json', JSON.stringify({
    themes: [{ short: 'mk-sha', version: '9.9.9', download: `${BASE}/mk-sha.zip`, sha256: sha(zip) }]
  }));
  const s2 = db.createThemeMarketSource({ name: 'ver', url: `${BASE}/catalog-ver.json` });
  await assert.rejects(() => market.installFromMarket(s2.id, 'mk-sha'), (e) => e.code === 'theme_version_mismatch');

  await assert.rejects(() => market.installFromMarket(s1.id, 'not-in-catalog'), (e) => e.code === 'theme_not_in_catalog');
});

test('installFromZip：compatibility 不满足时拒绝', async () => {
  const zip = makeZip(manifest('mk-incompat', '1.0.0', { diting: { compatibility: '>=999.0.0' } }));
  await assert.rejects(() => market.installFromZip(zip, {}), (e) => e.code === 'theme_incompatible');
  assert.strictEqual(fs.existsSync(path.join(theme.INSTALLED_THEMES_DIR, 'mk-incompat')), false);
});

// ---- 4. URL 导入 -------------------------------------------------------------

test('importFromURL：preview 只解析不落盘，正式导入才安装', async () => {
  const zip = makeZip(manifest('mk-import', '1.0.0'));
  serve('/mk-import.zip', zip, 'application/zip');
  const url = `${BASE}/mk-import.zip`;

  const preview = await market.importFromURL(url, true);
  assert.strictEqual(preview.manifest.short, 'mk-import');
  assert.strictEqual(preview.exists, false);
  assert.strictEqual(fs.existsSync(path.join(theme.INSTALLED_THEMES_DIR, 'mk-import')), false);

  const m = await market.importFromURL(url, false);
  assert.strictEqual(m.short, 'mk-import');
  assert.ok(fs.existsSync(path.join(theme.INSTALLED_THEMES_DIR, 'mk-import')));
});

test('resolveDownloadUrl：非 GitHub 地址原样返回，非法 URL 在下载阶段拒绝', async () => {
  const url = `${BASE}/mk-import.zip`;
  assert.strictEqual(await market.resolveDownloadUrl(url), url);
  await assert.rejects(() => market.importFromURL('not a url', true), (e) => e.code === 'url_invalid');
});

test('installFromZip：manifest 缺失 / ZIP 目录名与 manifest short 不一致', async () => {
  const zipNoManifest = new AdmZip();
  zipNoManifest.addFile('index.html', Buffer.from('x'));
  await assert.rejects(() => market.installFromZip(zipNoManifest.toBuffer(), {}), (e) => e.code === 'theme_manifest_missing');

  const zip = makeZip(manifest('mk-expect', '1.0.0'));
  await assert.rejects(() => market.installFromZip(zip, { short: 'other' }), (e) => e.code === 'theme_short_mismatch');
});

// ---- 5. 更新 / 回滚 ----------------------------------------------------------

test('updateTheme + rollbackTheme：覆盖前备份，回滚恢复旧版本', async () => {
  const v1 = makeZip(manifest('mk-up', '1.0.0'));
  const v2 = makeZip(manifest('mk-up', '1.1.0'));
  serve('/mk-up-v1.zip', v1, 'application/zip');
  serve('/mk-up-v2.zip', v2, 'application/zip');

  await market.importFromURL(`${BASE}/mk-up-v1.zip`, false);
  assert.strictEqual(theme.getTheme('mk-up').version, '1.0.0');

  const updated = await market.updateTheme('mk-up', { url: `${BASE}/mk-up-v2.zip` });
  assert.strictEqual(updated.version, '1.1.0');

  const backups = theme.listBackups('mk-up');
  assert.strictEqual(backups.length, 1, '覆盖前应生成一份备份');
  const restored = market.rollbackTheme('mk-up', backups[0].name);
  assert.strictEqual(restored.version, '1.0.0');

  await assert.rejects(async () => market.rollbackTheme('mk-up', 'mk-up.bak-1'), (e) => e.code === 'theme_backup_not_found');
  await assert.rejects(async () => market.rollbackTheme('mk-up', 'other.bak-1'), (e) => e.code === 'theme_backup_invalid');
});

test('updateTheme：无任何可用来源时报 update_source_required', async () => {
  await assert.rejects(() => market.updateTheme('mk-up'), (e) => e.code === 'update_source_required');
});

test('updateTheme / deleteTheme：内置主题只读', async () => {
  await assert.rejects(() => market.updateTheme('neobrutalism', { url: `${BASE}/x.zip` }), (e) => e.code === 'theme_bundled_readonly');
  assert.throws(() => theme.backupTheme('neobrutalism'), (e) => e.code === 'theme_bundled_readonly');
  assert.throws(() => theme.deleteTheme('neobrutalism'), (e) => e.code === 'theme_bundled_readonly');
});

// S5/F10：官方源种子默认 **disabled**（外部源需管理员显式授权后才启用）。
// 种子用 INSERT OR IGNORE ⇒ 只影响新建库；已有库保持管理员的既有选择不被覆盖。
test('官方主题源种子：默认 disabled（对齐方案口径）', () => {
  assert.strictEqual(db.OFFICIAL_THEME_MARKET.enabled, false,
    '官方源种子默认应为 disabled（外部源需显式授权）');
  const row = db.db.prepare('SELECT * FROM theme_market_sources WHERE id = ?').get(db.OFFICIAL_THEME_MARKET.id);
  if (row) {
    assert.strictEqual(row.enabled, 0, '新建库里的官方源应为禁用状态');
  }
  // 管理员手动启用后应能正常工作（禁用只是默认值，不是硬限制）
  const before = db.listThemeMarketSources().find((s) => s.id === db.OFFICIAL_THEME_MARKET.id);
  if (before) {
    db.updateThemeMarketSource(db.OFFICIAL_THEME_MARKET.id, { enabled: true });
    const after = db.listThemeMarketSources().find((s) => s.id === db.OFFICIAL_THEME_MARKET.id);
    assert.strictEqual(after.enabled, true, '管理员应能把官方源显式启用');
    db.updateThemeMarketSource(db.OFFICIAL_THEME_MARKET.id, { enabled: false });
  }
});
