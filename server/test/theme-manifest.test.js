'use strict';
// ============================================================
// S5/F10：主题 manifest 兼容链与列表归一化
// 覆盖：diting-theme.json → komari-theme.json → manifest.json 优先级、
// 严格校验（short / name / configuration.type）、i18n 归一化、
// 旧 manifest.json 豁免、needsRelaxedCsp 与 nonce 集合。
// ============================================================
process.env.DB_PATH = '/tmp/diting-theme-manifest.db';
process.env.THEMES_DIR = '/tmp/diting-theme-manifest-themes';

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

const theme = require('../src/theme');
const validators = require('../src/validate');

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch { /* 忽略 */ }
  }
});

function mkTheme(short, files) {
  const dir = path.join(ROOT, short);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));
  }
  return dir;
}

const BASE = { short: 'probe', name: 'Probe', version: '1.0.0' };

// ---- 1. 三级兼容优先级 ------------------------------------------------------

test('readManifest：diting-theme.json > komari-theme.json > manifest.json', () => {
  const dir = mkTheme('prio', {
    'diting-theme.json': { ...BASE, short: 'prio', name: 'from diting' },
    'komari-theme.json': { short: 'prio', name: 'from komari' },
    'manifest.json': { id: 'prio', name: 'from manifest' }
  });
  let m = theme.readManifest(dir, 'prio', false);
  assert.strictEqual(m.manifestFile, 'diting-theme.json');
  assert.strictEqual(m.name, 'from diting');

  fs.unlinkSync(path.join(dir, 'diting-theme.json'));
  m = theme.readManifest(dir, 'prio', false);
  assert.strictEqual(m.manifestFile, 'komari-theme.json');
  assert.strictEqual(m.name, 'from komari');

  fs.unlinkSync(path.join(dir, 'komari-theme.json'));
  m = theme.readManifest(dir, 'prio', false);
  assert.strictEqual(m.manifestFile, 'manifest.json');
  assert.strictEqual(m.name, 'from manifest');
  assert.strictEqual(m.legacy, true, 'manifest.json 应标记为旧格式');
  assert.strictEqual(m.bundled, false);
});

test('readManifest：非法 short / default / 无 manifest 返回 null', () => {
  const bad = mkTheme('bad-short', { 'diting-theme.json': { short: '../evil', name: 'x' } });
  assert.strictEqual(theme.readManifest(bad, 'bad-short', false), null);

  const def = mkTheme('def', { 'diting-theme.json': { short: 'default', name: 'x' } });
  assert.strictEqual(theme.readManifest(def, 'def', false), null);

  const empty = path.join(ROOT, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  assert.strictEqual(theme.readManifest(empty, 'empty', false), null);
});

// ---- 2. i18n 归一化 --------------------------------------------------------

test('readManifest：name/description/author 的 i18n map 归一化为字符串', () => {
  const dir = mkTheme('i18n', {
    'diting-theme.json': {
      short: 'i18n',
      name: { zh_CN: '中文名', en: 'English' },
      description: { en: 'English desc', zh_CN: '中文描述' },
      author: { name: { zh_CN: '作者' }, email: 'a@b.c' }
    }
  });
  const m = theme.readManifest(dir, 'i18n', false);
  assert.strictEqual(m.name, '中文名');
  assert.strictEqual(typeof m.description, 'string');
  assert.strictEqual(m.description, '中文描述');
  assert.strictEqual(m.author, '作者 <a@b.c>');
});

test('readManifest：无 name 时回退 short；configuration 仅 managed 生效', () => {
  const dir = mkTheme('noname', {
    'diting-theme.json': {
      short: 'noname',
      configuration: { type: 'managed', data: [{ key: 'accent', type: 'color', default: '#fff' }] }
    }
  });
  const m = theme.readManifest(dir, 'noname', false);
  assert.strictEqual(m.name, 'noname');
  assert.ok(m.configuration);
  assert.strictEqual(m.configuration.type, 'managed');
  assert.strictEqual(m.configurable, undefined, 'readManifest 不产出 configurable（列表层补）');
});

test('readManifest：needsRelaxedCsp 仅 true 时生效', () => {
  const dir = mkTheme('relax', { 'diting-theme.json': { ...BASE, short: 'relax', diting: { needsRelaxedCsp: true, compatibility: '>=1.0.0' } } });
  const m = theme.readManifest(dir, 'relax', false);
  assert.strictEqual(m.diting.needsRelaxedCsp, true);
  assert.strictEqual(m.diting.compatibility, '>=1.0.0');

  const dir2 = mkTheme('norelax', { 'diting-theme.json': { ...BASE, short: 'norelax', diting: { needsRelaxedCsp: 'yes' } } });
  assert.strictEqual(theme.readManifest(dir2, 'norelax', false).diting.needsRelaxedCsp, false);
});

test('readManifest：komari-theme.json 格式默认放宽 CSP（社区主题不写 diting 字段）', () => {
  // 真实社区主题（如 Glassmorphism v3.4.4）的 komari-theme.json 只有 name/short/version/
  // configuration，没有 diting.*；但产物含内联脚本 + 外部图标/汇率请求，严格 CSP 会阻断。
  const dir = mkTheme('kmdefault', { 'komari-theme.json': { ...BASE, short: 'kmdefault' } });
  const m = theme.readManifest(dir, 'kmdefault', false);
  assert.strictEqual(m.manifestFile, 'komari-theme.json');
  assert.strictEqual(m.diting.needsRelaxedCsp, true);
});

// ---- 3. 严格 manifest 校验 --------------------------------------------------

test('validateManifest：short/name 必填且格式受限', () => {
  assert.strictEqual(validators.validateManifest({ name: 'x' }).error, 'short_invalid');
  assert.strictEqual(validators.validateManifest({ short: 'default', name: 'x' }).error, 'short_invalid');
  assert.strictEqual(validators.validateManifest({ short: 'ok-name' }).error, 'name_required');
  assert.strictEqual(validators.validateManifest(null).error, 'manifest_invalid');
  assert.strictEqual(validators.validateManifest([{ short: 'a' }]).error, 'manifest_invalid');
});

test('validateManifest：configuration.type 仅接受 managed', () => {
  assert.strictEqual(
    validators.validateManifest({ short: 'a', name: 'A', configuration: { type: 'raw' } }).error,
    'configuration_type_unsupported'
  );
  assert.strictEqual(
    validators.validateManifest({ short: 'a', name: 'A', configuration: { type: 'redirect' } }).error,
    'configuration_type_unsupported'
  );
  const ok = validators.validateManifest({
    short: 'a',
    name: 'A',
    configuration: {
      type: 'managed',
      data: [
        { key: 'accent', name: { zh_CN: '主色' }, type: 'color', default: '#000' },
        { key: 'mode', type: 'select', options: 'a|b' },
        { key: 'flag', type: 'boolean', required: true }
      ]
    }
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.configuration.fields.length, 3);
  assert.deepStrictEqual(ok.value.configuration.fields[1].options, ['a', 'b']);
  assert.strictEqual(ok.value.configuration.fields[0].name, '主色');
});

test('validateManifest：字段 key / select options / 数量上限', () => {
  const badKey = validators.validateManifest({
    short: 'a', name: 'A', configuration: { type: 'managed', data: [{ key: 'a b' }] }
  });
  assert.strictEqual(badKey.error, 'configuration_field_key_invalid');

  const noOpt = validators.validateManifest({
    short: 'a', name: 'A', configuration: { type: 'managed', data: [{ key: 'k', type: 'select' }] }
  });
  assert.strictEqual(noOpt.error, 'configuration_field_options_required');

  const tooMany = validators.validateManifest({
    short: 'a', name: 'A', configuration: { type: 'managed', data: Array.from({ length: 51 }, (_, i) => ({ key: `k${i}` })) }
  });
  assert.strictEqual(tooMany.error, 'configuration_too_many_fields');
});

// ---- 4. 列表与内置主题 ------------------------------------------------------

test('listInstalledThemes：内置主题（旧 manifest.json）被识别且标记 bundled/legacy', () => {
  const list = theme.listInstalledThemes();
  const demo = list.find((t) => t.short === 'komari-demo');
  assert.ok(demo, '内置 komari-demo 应被识别');
  assert.strictEqual(demo.bundled, true);
  assert.strictEqual(demo.legacy, true);
  assert.strictEqual(demo.version, '');
  assert.strictEqual(typeof demo.name, 'string');

  const neo = list.find((t) => t.short === 'neobrutalism');
  assert.ok(neo);
  assert.strictEqual(neo.bundled, true);
});

test('listInstalledThemes：安装版同名主题覆盖内置版', () => {
  mkTheme('neobrutalism', { 'diting-theme.json': { short: 'neobrutalism', name: 'Override', version: '9.9.9' } });
  const neo = theme.listInstalledThemes().find((t) => t.short === 'neobrutalism');
  assert.strictEqual(neo.bundled, false);
  assert.strictEqual(neo.name, 'Override');
  fs.rmSync(path.join(ROOT, 'neobrutalism'), { recursive: true, force: true });
});

test('listInstalledThemes：跳过 .bak-<ts> 目录（备份在 themes 之外也不应被扫描）', () => {
  fs.mkdirSync(path.join(ROOT, 'ghost.bak-123'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'ghost.bak-123', 'diting-theme.json'), JSON.stringify({ short: 'ghost', name: 'G' }));
  const list = theme.listInstalledThemes();
  assert.strictEqual(list.some((t) => t.short === 'ghost'), false);
  fs.rmSync(path.join(ROOT, 'ghost.bak-123'), { recursive: true, force: true });
});

// ---- 5. nonce 集合动态构建 --------------------------------------------------

test('rebuildNonceSet：干净安装下不包含任何内置主题', () => {
  const set = theme.rebuildNonceSet();
  assert.strictEqual(theme.themeNonceSet, set, '必须复用同一个 Set 实例（server.js 持有引用）');
  assert.strictEqual(set.has('neobrutalism'), false);
  assert.strictEqual(set.has('komari-demo'), false);
});

test('rebuildNonceSet：needsRelaxedCsp=true 的主题被吸收，删除后移除', () => {
  mkTheme('relax-theme', { 'diting-theme.json': { ...BASE, short: 'relax-theme', name: 'R', diting: { needsRelaxedCsp: true } } });
  theme.rebuildNonceSet();
  assert.strictEqual(theme.themeNonceSet.has('relax-theme'), true);

  fs.rmSync(path.join(ROOT, 'relax-theme'), { recursive: true, force: true });
  theme.rebuildNonceSet();
  assert.strictEqual(theme.themeNonceSet.has('relax-theme'), false);
});
