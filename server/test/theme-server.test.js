'use strict';
// ============================================================
// S5/F10：主题市场 API 端到端（supertest）
// 覆盖鉴权矩阵、源 CRUD、catalog、安装→启用→配置→删除、
// /themes/:short/config 路由优先级与 public_enabled 门控、
// 审计 detail 字符串化、nonce 集合动态构建。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'theme-admin-token-0123456789abcdef';
process.env.READONLY_TOKEN = 'theme-readonly-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-theme-server.db';
process.env.THEMES_DIR = '/tmp/diting-theme-server/themes';
process.env.ALLOW_INSECURE_WEBHOOK = '1';
process.env.ALLOW_PRIVATE_WEBHOOK = '1';

const { test, after, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const request = require('supertest');

const DB = process.env.DB_PATH;
const ROOT = '/tmp/diting-theme-server';
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(DB + suffix); } catch { /* 忽略 */ }
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const ai = require('../src/ai');
const theme = require('../src/theme');

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };
const READONLY = { 'X-Readonly-Token': process.env.READONLY_TOKEN, 'X-Forwarded-Proto': 'https' };

// ---- 本地市场源 -------------------------------------------------------------
const routes = new Map();
const marketServer = http.createServer((req, res) => {
  const r = routes.get(req.url);
  if (!r) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', r.type || 'application/json; charset=utf-8');
  res.end(r.body);
});
let BASE = '';

before(async () => {
  await new Promise((resolve) => marketServer.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${marketServer.address().port}`;
});

after(async () => {
  alerts.stop();
  ai.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  await new Promise((r) => marketServer.close(r));
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch { /* 忽略 */ }
  }
});

// 带 managed 配置的主题包
const THEME = {
  short: 'srv-theme',
  name: { zh_CN: '服务端主题', en: 'Server Theme' },
  version: '1.0.0',
  configuration: {
    type: 'managed',
    data: [
      { key: 'accent', type: 'color', default: '#123456' },
      { key: 'mode', type: 'select', options: ['a', 'b'], default: 'a' },
      { key: 'show_ip', type: 'boolean', default: false }
    ]
  }
};
function themeZip(manifest) {
  const zip = new AdmZip();
  zip.addFile('diting-theme.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('index.html', Buffer.from('<!doctype html><html><body>srv</body></html>'));
  return zip.toBuffer();
}
let sourceId = '';

// ---- 1. 鉴权 ----------------------------------------------------------------

test('GET /api/admin/theme/list：无凭证 401，只读凭证可读', async () => {
  const anon = await request(app).get('/api/admin/theme/list').set('X-Forwarded-Proto', 'https');
  assert.strictEqual(anon.status, 401);

  const ro = await request(app).get('/api/admin/theme/list').set(READONLY);
  assert.strictEqual(ro.status, 200);
  assert.ok(Array.isArray(ro.body));
});

test('POST /api/admin/theme/market/sources：只读凭证 403', async () => {
  const res = await request(app).post('/api/admin/theme/market/sources').set(READONLY).send({ name: 'x', url: 'https://example.com/c.json' });
  assert.strictEqual(res.status, 403);
});

// ---- 2. 源 CRUD -------------------------------------------------------------

test('源 CRUD：创建 → 重复 URL 409 → 更新 → 删除', async () => {
  const zip = themeZip(THEME);
  routes.set('/catalog.json', {
    body: JSON.stringify({
      themes: [{
        short: THEME.short,
        name: 'Server Theme',
        version: THEME.version,
        download: `${BASE}/theme.zip`,
        sha256: crypto.createHash('sha256').update(zip).digest('hex')
      }]
    })
  });
  routes.set('/theme.zip', { body: zip, type: 'application/zip' });

  const created = await request(app).post('/api/admin/theme/market/sources').set(ADMIN)
    .send({ name: 'Local', url: `${BASE}/catalog.json` });
  assert.strictEqual(created.status, 200);
  assert.match(created.body.id, /^src_[0-9a-f]{12}$/);
  sourceId = created.body.id;

  const dup = await request(app).post('/api/admin/theme/market/sources').set(ADMIN)
    .send({ name: 'Local2', url: `${BASE}/catalog.json` });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.body.error, 'source_url_conflict');

  const updated = await request(app).put(`/api/admin/theme/market/sources/${sourceId}`).set(ADMIN)
    .send({ name: 'Local Renamed' });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.name, 'Local Renamed');

  const bad = await request(app).post('/api/admin/theme/market/sources').set(ADMIN)
    .send({ name: 'x', url: 'ftp://example.com/a.json' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error, 'url_scheme_invalid');
});

test('GET /api/admin/theme/market/catalog：聚合源并可直接刷新', async () => {
  const res = await request(app).get('/api/admin/theme/market/catalog?refresh=true').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.themes.some((t) => t.short === THEME.short));
  assert.ok(res.body.sources.some((s) => s.id === sourceId && s.count === 1 && !s.error));
});

// ---- 3. 安装 → 列表 → 启用 ---------------------------------------------------

test('安装：market install → list 可见（bundled/legacy 字段齐全）', async () => {
  const install = await request(app).post('/api/admin/theme/market/install').set(ADMIN)
    .send({ source_id: sourceId, short: THEME.short });
  assert.strictEqual(install.status, 200);
  assert.strictEqual(install.body.manifest.short, THEME.short);

  const list = await request(app).get('/api/admin/theme/list').set(ADMIN);
  const item = list.body.find((t) => t.short === THEME.short);
  assert.ok(item);
  assert.strictEqual(item.name, '服务端主题');
  assert.strictEqual(item.bundled, false);
  assert.strictEqual(item.configurable, true);
  assert.strictEqual(typeof item.description, 'string');
  assert.ok(list.body.some((t) => t.short === 'neobrutalism' && t.bundled === true));
});

test('POST /api/admin/theme/set：启用已装主题（非 GET）', async () => {
  const res = await request(app).post('/api/admin/theme/set').set(ADMIN).send({ theme: THEME.short });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.enabled, THEME.short);
  assert.strictEqual(db.getUiSettings().public_theme, THEME.short);

  const get = await request(app).get('/api/admin/theme/set').set(ADMIN);
  assert.strictEqual(get.status, 404, '不应存在 GET /set');

  const missing = await request(app).post('/api/admin/theme/set').set(ADMIN).send({ theme: 'nope' });
  assert.strictEqual(missing.status, 404);
});

// ---- 4. 配置值 ---------------------------------------------------------------

test('配置：GET 默认值 → POST 保存 → GET 回读 → 未知 key 400', async () => {
  const initial = await request(app).get(`/api/admin/theme/config?theme=${THEME.short}`).set(ADMIN);
  assert.strictEqual(initial.status, 200);
  assert.deepStrictEqual(initial.body.values, { accent: '#123456', mode: 'a', show_ip: false });

  const saved = await request(app).post(`/api/admin/theme/config?theme=${THEME.short}`).set(ADMIN)
    .send({ accent: '#abcdef', mode: 'b', show_ip: true });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.saved, true);

  const reread = await request(app).get(`/api/admin/theme/config?theme=${THEME.short}`).set(ADMIN);
  assert.deepStrictEqual(reread.body.values, { accent: '#abcdef', mode: 'b', show_ip: true });

  const unknown = await request(app).post(`/api/admin/theme/config?theme=${THEME.short}`).set(ADMIN)
    .send({ nope: 'x' });
  assert.strictEqual(unknown.status, 400);
  assert.strictEqual(unknown.body.error, 'config_key_unknown');

  const badSelect = await request(app).post(`/api/admin/theme/config?theme=${THEME.short}`).set(ADMIN)
    .send({ mode: 'z' });
  assert.strictEqual(badSelect.status, 400);
  assert.strictEqual(badSelect.body.error, 'config_value_invalid');
});

test('GET /themes/:short/config：不被 /themes/:short/(.*) 抢占，返回配置 JSON', async () => {
  const res = await request(app).get(`/themes/${THEME.short}/config`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.accent, '#abcdef');
  assert.strictEqual(res.headers['content-type'], 'application/json; charset=utf-8');
});

test('public_enabled=false：config 端点 403，而 /api/public/themes 仍可用', async () => {
  const ui = db.getUiSettings();
  db.setUiSettings({ ...ui, public_enabled: false });

  const conf = await request(app).get(`/themes/${THEME.short}/config`);
  assert.strictEqual(conf.status, 403);
  assert.strictEqual(conf.body.error, 'public_disabled');

  const pub = await request(app).get('/api/public/themes');
  assert.strictEqual(pub.status, 200);
  assert.ok(pub.body.some((t) => t.id === THEME.short && t.short === THEME.short));

  db.setUiSettings({ ...db.getUiSettings(), public_enabled: true });
});

// ---- 5. 兼容 / 审计 / 删除 ----------------------------------------------------

test('GET /api/public/themes：保留历史 id 字段且 name 已归一化', async () => {
  const res = await request(app).get('/api/public/themes');
  assert.strictEqual(res.status, 200);
  const legacy = res.body.find((t) => t.id === 'komari-demo');
  assert.ok(legacy, '旧 manifest.json 主题应仍可识别');
  assert.strictEqual(legacy.name, 'Komari 适配皮肤（演示）');
  assert.strictEqual(typeof legacy.name, 'string');
});

test('审计：theme_action 的 detail 为字符串并成功入库', () => {
  const logs = db.getAuditLogs(100).filter((l) => l.action === 'theme_action');
  assert.ok(logs.length >= 4, '源创建/更新/安装/启用/配置应产生审计');
  for (const l of logs) assert.strictEqual(typeof l.detail, 'string');
  assert.ok(logs.some((l) => l.detail.includes('op=market_install')));
});

test('POST /api/admin/theme/delete：删除当前启用主题后回退 default', async () => {
  const res = await request(app).post('/api/admin/theme/delete').set(ADMIN).send({ short: THEME.short });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.deleted, true);
  assert.strictEqual(res.body.fallbackTheme, 'default');
  assert.strictEqual(db.getUiSettings().public_theme, 'default');
  assert.strictEqual(fs.existsSync(path.join(theme.INSTALLED_THEMES_DIR, THEME.short)), false);

  const bundled = await request(app).post('/api/admin/theme/delete').set(ADMIN).send({ short: 'neobrutalism' });
  assert.strictEqual(bundled.status, 409);
  assert.strictEqual(bundled.body.error, 'theme_bundled_readonly');
});

test('源删除：DELETE 后不再出现在 sources 列表', async () => {
  const res = await request(app).delete(`/api/admin/theme/market/sources/${sourceId}`).set(ADMIN);
  assert.strictEqual(res.status, 200);
  const list = await request(app).get('/api/admin/theme/market/sources').set(ADMIN);
  assert.strictEqual(list.body.some((s) => s.id === sourceId), false);
});

// ---- 6. nonce 集合 ----------------------------------------------------------

test('nonce 集合：直接落盘 needsRelaxedCsp 主题后重建，删除后移除', () => {
  const dir = path.join(theme.INSTALLED_THEMES_DIR, 'srv-relax');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'diting-theme.json'), JSON.stringify({
    short: 'srv-relax', name: 'Relax', version: '1.0.0', diting: { needsRelaxedCsp: true }
  }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');

  theme.rebuildNonceSet();
  assert.strictEqual(theme.themeNonceSet.has('srv-relax'), true);

  fs.rmSync(dir, { recursive: true, force: true });
  theme.rebuildNonceSet();
  assert.strictEqual(theme.themeNonceSet.has('srv-relax'), false);
});
