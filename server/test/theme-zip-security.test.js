'use strict';
// ============================================================
// S5/F10：主题 ZIP 解压安全边界
// 用手工构造的 ZIP（可任意写 entry 名与 unix mode）覆盖：
// 路径穿越 / 绝对路径 / 符号链接 / 声明大小造假 / 文件数上限 / 损坏包 / 空包。
// ============================================================
process.env.DB_PATH = '/tmp/diting-theme-zip.db';
process.env.THEMES_DIR = '/tmp/diting-theme-zip/themes';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB = process.env.DB_PATH;
const ROOT = '/tmp/diting-theme-zip';
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(DB + suffix); } catch { /* 忽略 */ }
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const market = require('../src/theme-market');

const tmpDirs = [];
function tmpDest() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-zip-test-'));
  tmpDirs.push(d);
  return d;
}

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch { /* 忽略 */ }
  }
});

// ---- 最小 ZIP 构造器（store 模式，可伪造任意 entry 名 / unix mode / 声明大小）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * entries: [{ name, data, mode?, declaredSize? }]
 * mode 默认 0o100644；0xA1FF 可构造符号链接条目。
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data || '');
    const crc = crc32(data);
    const declared = e.declaredSize !== undefined ? e.declaredSize : data.length;
    const mode = e.mode !== undefined ? e.mode : 0o100644;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);           // method = store
    local.writeUInt32LE(0, 10);          // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);   // 未压缩大小（可伪造）
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);  // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);            // method store
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((mode << 16) >>> 0), 38); // external attributes
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const MANIFEST = Buffer.from(JSON.stringify({ short: 'zip-test', name: 'ZIP Test', version: '1.0.0' }));
const INDEX = Buffer.from('<!doctype html><html></html>');

// ---- 1. 正常包 ---------------------------------------------------------------

test('extractZip：正常包按 entry 落盘并返回统计', () => {
  const dest = tmpDest();
  const buf = buildZip([
    { name: 'diting-theme.json', data: MANIFEST },
    { name: 'index.html', data: INDEX },
    { name: 'assets/app.js', data: 'console.log(1)' }
  ]);
  const r = market.extractZip(buf, dest);
  assert.strictEqual(r.files, 3);
  assert.ok(fs.existsSync(path.join(dest, 'assets', 'app.js')));
});

// ---- 2. 路径穿越 / 绝对路径 ---------------------------------------------------

test('extractZip：../ 路径穿越被拒绝', () => {
  assert.throws(() => market.extractZip(buildZip([{ name: '../evil.txt', data: 'x' }]), tmpDest()),
    (e) => e.code === 'zip_unsafe_path');
});

test('extractZip：..\\ 反斜杠穿越被拒绝', () => {
  assert.throws(() => market.extractZip(buildZip([{ name: '..\\evil.txt', data: 'x' }]), tmpDest()),
    (e) => e.code === 'zip_unsafe_path');
});

test('extractZip：绝对路径 / Windows 盘符被拒绝', () => {
  assert.throws(() => market.extractZip(buildZip([{ name: '/etc/passwd', data: 'x' }]), tmpDest()),
    (e) => e.code === 'zip_unsafe_path');
  assert.throws(() => market.extractZip(buildZip([{ name: 'C:/Windows/evil.txt', data: 'x' }]), tmpDest()),
    (e) => e.code === 'zip_unsafe_path');
});

test('extractZip：中间段 .. 同样被拒绝', () => {
  assert.throws(() => market.extractZip(buildZip([{ name: 'a/../../evil.txt', data: 'x' }]), tmpDest()),
    (e) => e.code === 'zip_unsafe_path');
});

// ---- 3. 符号链接 -------------------------------------------------------------

test('extractZip：符号链接条目被拒绝（unix mode 0xA000）', () => {
  assert.throws(() => market.extractZip(buildZip([
    { name: 'diting-theme.json', data: MANIFEST },
    { name: 'passwd', data: '/etc/passwd', mode: 0xA1FF }
  ]), tmpDest()), (e) => e.code === 'theme_zip_symlink_forbidden');
});

// ---- 4. 体积 / 数量边界 -------------------------------------------------------

test('extractZip：声明大小造假（header.size 超单文件上限）被拒绝', () => {
  assert.throws(() => market.extractZip(buildZip([
    { name: 'bomb.bin', data: 'small', declaredSize: market.ZIP_MAX_FILE_BYTES + 1 }
  ]), tmpDest()), (e) => e.code === 'theme_zip_too_large');
});

test('extractZip：文件数超过上限被拒绝', () => {
  const entries = [];
  for (let i = 0; i <= market.ZIP_MAX_FILES; i++) entries.push({ name: `f/${i}.txt`, data: '' });
  assert.throws(() => market.extractZip(buildZip(entries), tmpDest()),
    (e) => e.code === 'theme_zip_too_many_files');
});

// ---- 5. 损坏 / 空包 -----------------------------------------------------------

test('extractZip：损坏包与空包分别报 theme_zip_invalid / theme_zip_empty', () => {
  assert.throws(() => market.extractZip(Buffer.from('not a zip at all'), tmpDest()),
    (e) => e.code === 'theme_zip_invalid');
  assert.throws(() => market.extractZip(buildZip([{ name: 'dir/', data: '' }]), tmpDest()),
    (e) => e.code === 'theme_zip_empty');
});
