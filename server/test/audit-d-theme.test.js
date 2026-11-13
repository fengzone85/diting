'use strict';
// ============================================================
// 外部审查复核 Batch D：D1 satisfies fail-closed + D4 主题更新原子替换。
// 负向对照：git show HEAD:server/src/theme-market.js 旧版跑本文件应失败。
// ============================================================
process.env.DB_PATH = '/tmp/diting-audit-d-theme.db';
process.env.THEMES_DIR = '/tmp/diting-audit-d-theme/themes';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const ROOT = '/tmp/diting-audit-d-theme';
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const db = require('../src/db');
const theme = require('../src/theme');
const market = require('../src/theme-market');

after(() => {
  db.flushTraffic();
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

function makeZip(manifest, extra = {}) {
  const zip = new AdmZip();
  zip.addFile('diting-theme.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('index.html', Buffer.from('<!doctype html><html><body>ok</body></html>'));
  for (const [name, data] of Object.entries(extra)) zip.addFile(name, Buffer.from(data));
  return zip.toBuffer();
}
const manifest = (short, version, extra = {}) => ({ short, name: `Theme ${short}`, version, ...extra });

// ---- D1：畸形版本 / range 一律 fail-closed ---------------------------------
test('D1 satisfies：畸形版本与畸形 range 段不放行', () => {
  const bad = [
    ['garbage', '>=1.0.0'],
    ['', '>=1.0.0'],
    [null, '>=1.0.0'],
    ['1.0.0', '>=abc'],
    ['1.0.0', 'not-a-range'],
    ['1.0.0', '^x.y'],
    ['1.0.0', '>=1.0.0 || <0.5.0'],
    ['1.0.0', '>=1.0.0 banana'],
  ];
  for (const [v, r] of bad) {
    assert.strictEqual(market.satisfies(v, r), false, `satisfies(${JSON.stringify(v)}, ${JSON.stringify(r)}) 应 fail-closed`);
  }
});

test('D1 satisfies：空 range 放行（无约束）与正常语义不变', () => {
  const good = [
    ['1.0.0', ''],
    ['1.0.0', '   '],
    ['1.0.0', '>=1.0.0'],
    ['1.0.0', '>=0.9 <2.0.0'],
    ['1.2.3', '^1.0.0'],
    ['1.2.3', '~1.2.0'],
    ['2.0.0', '>=1.0.0'],
  ];
  for (const [v, r] of good) {
    assert.strictEqual(market.satisfies(v, r), true, `satisfies(${v}, ${r}) 应放行`);
  }
  assert.strictEqual(market.satisfies('2.0.0', '^1.0.0'), false);
  assert.strictEqual(market.satisfies('1.0.0', '>=999.0.0'), false);
});

test('D1 安装回归：合法 range 不误杀，畸形 range 在安装期被拒', async () => {
  await market.installFromZip(makeZip(manifest('d1-ok', '1.0.0', { diting: { compatibility: '>=1.0.0' } })));
  assert.strictEqual(theme.getTheme('d1-ok').version, '1.0.0');

  await assert.rejects(
    () => market.installFromZip(makeZip(manifest('d1-bad', '1.0.0', { diting: { compatibility: '>=abc' } }))),
    (e) => e.code === 'theme_incompatible'
  );
  await assert.rejects(
    () => market.installFromZip(makeZip(manifest('d1-high', '1.0.0', { diting: { compatibility: '>=999.0.0' } }))),
    (e) => e.code === 'theme_incompatible'
  );

  // 旧格式 manifest.json 无 diting 字段 → 豁免（内置主题同款路径）
  const legacy = new AdmZip();
  legacy.addFile('manifest.json', Buffer.from(JSON.stringify({ short: 'd1-legacy', name: 'L', version: '1.0.0' })));
  legacy.addFile('index.html', Buffer.from('<html></html>'));
  await market.installFromZip(legacy.toBuffer());
  assert.strictEqual(theme.getTheme('d1-legacy').version, '1.0.0');
});

// ---- D4：覆盖安装原子替换 + 失败回滚 ---------------------------------------
test('D4 覆盖安装：staging+rename 就位，无残留目录', async () => {
  await market.installFromZip(makeZip(manifest('d4-up', '1.0.0'), { 'marker.txt': 'v1' }));
  await market.installFromZip(makeZip(manifest('d4-up', '1.1.0'), { 'marker.txt': 'v2' }));
  assert.strictEqual(theme.getTheme('d4-up').version, '1.1.0');
  assert.strictEqual(fs.readFileSync(path.join(process.env.THEMES_DIR, 'd4-up', 'marker.txt'), 'utf8'), 'v2');
  const leftovers = fs.readdirSync(process.env.THEMES_DIR).filter((n) => n.startsWith('.staging-') || n.includes('.old-'));
  assert.deepStrictEqual(leftovers, [], '不应留下 staging/old 目录');
});

test('D4 替换失败：旧目录回滚，主题不丢', async () => {
  const realRename = fs.renameSync;
  fs.renameSync = (src, dst) => {
    if (String(src).includes('.staging-') && String(dst).endsWith(`${path.sep}d4-up`)) {
      throw Object.assign(new Error('EIO: simulated rename failure'), { code: 'EIO' });
    }
    return realRename(src, dst);
  };
  try {
    await assert.rejects(
      () => market.installFromZip(makeZip(manifest('d4-up', '2.0.0'), { 'marker.txt': 'v3' })),
      (e) => e.code === 'EIO'
    );
  } finally {
    fs.renameSync = realRename;
  }
  assert.strictEqual(theme.getTheme('d4-up').version, '1.1.0', '失败后应保留旧版本');
  assert.strictEqual(fs.readFileSync(path.join(process.env.THEMES_DIR, 'd4-up', 'marker.txt'), 'utf8'), 'v2');
  const leftovers = fs.readdirSync(process.env.THEMES_DIR).filter((n) => n.startsWith('.staging-') || n.includes('.old-'));
  assert.deepStrictEqual(leftovers, [], '失败路径也应清理 staging/old');
});

test('D4 回滚：backupTheme 保留，rollback 恢复旧版', async () => {
  const backups = theme.listBackups('d4-up');
  assert.ok(backups.length >= 1, '覆盖前应生成备份');
  // 失败的 v3 尝试也备份了当时的 v1.1.0，按内容挑 v1 那份
  const backupRoot = path.join(path.dirname(process.env.THEMES_DIR), 'theme-backups');
  const v1Backup = backups.find((b) => {
    try { return fs.readFileSync(path.join(backupRoot, b.name, 'marker.txt'), 'utf8') === 'v1'; } catch { return false; }
  });
  assert.ok(v1Backup, '应存在 v1 内容的备份');
  const restored = market.rollbackTheme('d4-up', v1Backup.name);
  assert.strictEqual(restored.version, '1.0.0');
  assert.strictEqual(fs.readFileSync(path.join(process.env.THEMES_DIR, 'd4-up', 'marker.txt'), 'utf8'), 'v1');
});