'use strict';
// ============================================================
// S5/F10：主题市场下载的 SSRF 防护（默认拒绝）
// 本文件刻意不设置 ALLOW_PRIVATE_WEBHOOK / ALLOW_INSECURE_WEBHOOK，
// 验证安全默认：私网 / 回环 / 链路本地 / 明文 http 一律拒绝。
// 放行局域网自建源的路径见 theme-market.test.js。
// ============================================================
process.env.DB_PATH = '/tmp/diting-theme-ssrf.db';
process.env.THEMES_DIR = '/tmp/diting-theme-ssrf/themes';
delete process.env.ALLOW_PRIVATE_WEBHOOK;
delete process.env.ALLOW_INSECURE_WEBHOOK;

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const DB = process.env.DB_PATH;
const ROOT = '/tmp/diting-theme-ssrf';
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(DB + suffix); } catch { /* 忽略 */ }
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const market = require('../src/theme-market');
const notify = require('../src/notify');
const db = require('../src/db');

// 测试隔离：官方源种子默认启用且会发起真实网络请求，会污染下面的目录断言。
db.deleteThemeMarketSource('official');

test('pinnedLookup：兼容 autoSelectFamily 的 { all: true } 调用（回归 ERR_INVALID_IP_ADDRESS）', () => {
  const lookup = notify._internal.pinnedLookup('203.0.113.10', 4);

  let addrs;
  lookup('example.com', { all: true }, (err, list) => { assert.ifError(err); addrs = list; });
  assert.deepStrictEqual(addrs, [{ address: '203.0.113.10', family: 4 }], 'all:true 必须返回地址数组');

  let addr, fam;
  lookup('example.com', { all: false }, (err, a, f) => { assert.ifError(err); addr = a; fam = f; });
  assert.strictEqual(addr, '203.0.113.10');
  assert.strictEqual(fam, 4);
});

test('selectResolvedAddress：忽略 :: / 0.0.0.0 伪答案，仍钉住公网地址（回归 blocked_target 误判）', () => {
  const { selectResolvedAddress } = notify._internal;

  // 部分 DNS 对 AAAA 返回 ::，不应因此否决同样解析出的公网 IPv4
  assert.deepStrictEqual(selectResolvedAddress([
    { address: '185.199.109.133', family: 4 },
    { address: '::', family: 6 }
  ], false), { address: '185.199.109.133', family: 4 });

  // 只剩伪答案 → 仍然拒绝
  assert.throws(() => selectResolvedAddress([{ address: '::', family: 6 }], false), /blocked_target/);
  assert.throws(() => selectResolvedAddress([{ address: '0.0.0.0', family: 4 }], false), /blocked_target/);

  // 真正混入私网地址 → 保留「任一受限即拒绝」的严格策略
  assert.throws(() => selectResolvedAddress([
    { address: '185.199.109.133', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ], false), /blocked_target/);

  // 放行私网时也优先选非 unspecified 地址
  assert.deepStrictEqual(selectResolvedAddress([
    { address: '::', family: 6 },
    { address: '10.0.0.2', family: 4 }
  ], true), { address: '10.0.0.2', family: 4 });

  assert.throws(() => selectResolvedAddress([], false), /dns_empty/);
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch { /* 忽略 */ }
  }
});

const codeOf = async (fn) => {
  try { await fn(); } catch (e) { return e.code; }
  return null;
};

test('safeDownload：明文 http 默认拒绝（insecure_scheme）', async () => {
  assert.strictEqual(await codeOf(() => market.safeDownload('http://example.com/a.zip')), 'insecure_scheme');
});

test('safeDownload：非 http(s) / 非法 URL 拒绝', async () => {
  assert.strictEqual(await codeOf(() => market.safeDownload('ftp://example.com/a.zip')), 'scheme_invalid');
  assert.strictEqual(await codeOf(() => market.safeDownload('not a url')), 'url_invalid');
});

test('safeDownload：回环 / 私网 / 链路本地 / 保留段全部拒绝', async () => {
  const targets = [
    'https://127.0.0.1/a.zip',
    'https://10.0.0.1/a.zip',
    'https://172.16.0.1/a.zip',
    'https://192.168.1.1/a.zip',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/a.zip',
    'https://[::1]/a.zip',
    'https://[fc00::1]/a.zip',
    'https://localhost/a.zip'
  ];
  for (const url of targets) {
    assert.strictEqual(await codeOf(() => market.safeDownload(url)), 'blocked_target', `${url} 应被拒绝`);
  }
});

test('importFromURL：私网 URL 在下载阶段被拒绝，不落盘', async () => {
  assert.strictEqual(await codeOf(() => market.importFromURL('https://127.0.0.1/evil.zip', false)), 'blocked_target');
  assert.strictEqual(fs.existsSync(`${ROOT}/themes/evil`), false);
});

test('installFromMarket：启用源为私网时 catalog 拉取失败并标注错误码', async () => {
  const src = db.createThemeMarketSource({ name: 'private', url: 'https://127.0.0.1/catalog.json' });
  const result = await market.listMarketThemes(true);
  assert.strictEqual(result.themes.length, 0);
  assert.ok(result.errors.some((e) => e.source_id === src.id && e.error === 'blocked_target'));
  db.deleteThemeMarketSource(src.id);
});
