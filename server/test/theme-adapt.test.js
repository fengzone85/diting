'use strict';
// ============================================================
// 主题 index.html 的根绝对路径重写（adaptThemeHtml）
//
// 背景：Komari 生态主题的构建产物普遍用 `/assets/...`、`/favicon.ico` 这类根绝对路径，
// 而 diting 把主题挂在 /themes/<short>/ 下。原样投放会请求到 diting 自己的 /assets，
// 表现为白屏或 404。
//
// 约束（守住即可随时用官方 zip 覆盖主题）：
//   1) 只有首段能在主题目录里找到时才加前缀（assets/ images/ favicon.ico …）；
//   2) 主题自己的 SPA 路由（如 /instance/<uuid>）必须保持原样；
//   3) 协议相对（//cdn）与外部 URL 不动；
//   4) 磁盘上的 index.html 不被改写（只在响应里重写）。
// ============================================================
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-theme-adapt-'));
const THEME_SHORT = 'adapt-demo';
const THEME_DIR = path.join(TMP, 'themes', THEME_SHORT);

fs.mkdirSync(path.join(THEME_DIR, 'assets'), { recursive: true });
fs.mkdirSync(path.join(THEME_DIR, 'images'), { recursive: true });
fs.writeFileSync(path.join(THEME_DIR, 'assets', 'app.js'), 'console.log(1)');
fs.writeFileSync(path.join(THEME_DIR, 'assets', 'app.css'), '.a{}');
fs.writeFileSync(path.join(THEME_DIR, 'images', 'logo.png'), 'png');
fs.writeFileSync(path.join(THEME_DIR, 'favicon.ico'), 'ico');

const INDEX_HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="/favicon.ico">
<script src="/assets/app.js"></script>
</head><body>
<a href="/instance/abc-123">node</a>
<img src="//cdn.example.com/a.png">
<a href="https://example.com/x">ext</a>
<script>window.__INLINE__=1</script>
</body></html>`;
fs.writeFileSync(path.join(THEME_DIR, 'index.html'), INDEX_HTML);

process.env.THEMES_DIR = path.join(TMP, 'themes');
process.env.DB_PATH = path.join(TMP, 'monitor.db');
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';

const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, server } = require('../server');

after(async () => {
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

test('根绝对引用按主题目录一级条目加前缀', async () => {
  const res = await request(app).get(`/themes/${THEME_SHORT}/`);
  assert.strictEqual(res.status, 200);
  const html = res.text;
  assert.match(html, new RegExp(`href="/themes/${THEME_SHORT}/assets/app\\.css"`), 'CSS 应加前缀');
  assert.match(html, new RegExp(`src="/themes/${THEME_SHORT}/assets/app\\.js"`), 'JS 应加前缀');
  assert.match(html, new RegExp(`href="/themes/${THEME_SHORT}/favicon\\.ico"`), 'favicon 应加前缀');
});

test('主题自有 SPA 路由与外部 URL 保持原样', async () => {
  const res = await request(app).get(`/themes/${THEME_SHORT}/`);
  const html = res.text;
  assert.match(html, /href="\/instance\/abc-123"/, 'SPA 深链不得改写（目录内无 instance 条目）');
  assert.match(html, /src="\/\/cdn\.example\.com\/a\.png"/, '协议相对 URL 不得改写');
  assert.match(html, /href="https:\/\/example\.com\/x"/, '外部 URL 不得改写');
});

test('无后缀深链同样回退到重写后的 index.html', async () => {
  const res = await request(app).get(`/themes/${THEME_SHORT}/instance/abc-123`);
  assert.strictEqual(res.status, 200);
  assert.match(res.text, new RegExp(`/themes/${THEME_SHORT}/assets/app\\.js`), '深链回退也要重写资源');
});

test('磁盘上的 index.html 不被改写（模板产物保持原样）', () => {
  const raw = fs.readFileSync(path.join(THEME_DIR, 'index.html'), 'utf8');
  assert.strictEqual(raw, INDEX_HTML, '重写只发生在响应阶段');
});

test('主题静态资源仍按原路径投放', async () => {
  const js = await request(app).get(`/themes/${THEME_SHORT}/assets/app.js`);
  assert.strictEqual(js.status, 200);
  assert.match(String(js.headers['content-type']), /javascript/);
  assert.strictEqual(js.text, 'console.log(1)');
});
