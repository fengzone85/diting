'use strict';

/**
 * S5/F10 主题基础设施。
 *
 * 目录策略（见 IMPLEMENTATION_PLAN §11 F10.3）：
 * - THEMES_DIR：运行时安装目录，落在数据库同级（Docker 下 /data/themes，随卷持久）；
 * - BUNDLED_THEMES_DIR：随发行版分发的只读内置主题（public/themes）；
 * - 解析顺序：安装目录 → 内置目录，同名时安装版优先。
 *
 * 本模块只做文件系统与配置读写，不做 ZIP 解压/下载（见 theme-market.js）。
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const INSTALLED_THEMES_DIR = process.env.THEMES_DIR
  ? path.resolve(process.env.THEMES_DIR)
  : path.join(path.dirname(db.DB_PATH), 'themes');
const BUNDLED_THEMES_DIR = path.join(__dirname, '..', 'public', 'themes');
// 备份放在 themes 之外：避免备份目录被目录扫描当成主题，也避免污染 git 工作区。
const BACKUP_DIR = path.join(path.dirname(INSTALLED_THEMES_DIR), 'theme-backups');

const SHORT_RE = /^[A-Za-z0-9_-]+$/;
const BACKUP_RE = /\.bak-\d+$/;
const MANIFEST_FILES = ['diting-theme.json', 'komari-theme.json', 'manifest.json'];
const MAX_MANIFEST_BYTES = 1024 * 1024;

function ensureInstalledDir() {
  fs.mkdirSync(INSTALLED_THEMES_DIR, { recursive: true });
}

/** 把 string / i18n map 归一化成展示字符串（P1-b：前端直接渲染 name）。 */
function localized(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of ['zh_CN', 'zh', 'en', 'en_US']) {
      if (typeof value[k] === 'string' && value[k].trim()) return value[k].trim();
    }
    for (const v of Object.values(value)) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

/** author 既可能是字符串，也可能是 {name,email,url}。统一成 "name <email>"。 */
function normalizeAuthor(author) {
  if (typeof author === 'string') return author.trim();
  if (author && typeof author === 'object') {
    const name = localized(author.name);
    const email = typeof author.email === 'string' ? author.email.trim() : '';
    if (name && email) return `${name} <${email}>`;
    if (name) return name;
    if (email) return email;
  }
  return '';
}

function readManifestFile(fp) {
  let st;
  try { st = fs.statSync(fp); } catch (e) { return null; }
  if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch (e) { return null; }
}

/**
 * 读取目录下的 manifest（三级兼容），返回归一化 Theme 对象；无 manifest 返回 null。
 * 不抛异常：列表/扫描场景下坏 manifest 只跳过（安装场景另有严格校验）。
 */
function readManifest(dir, shortHint, bundled = false) {
  const fallbackShort = shortHint || path.basename(dir);
  for (const file of MANIFEST_FILES) {
    const raw = readManifestFile(path.join(dir, file));
    if (!raw) continue;

    const short = String(raw.short || raw.id || fallbackShort);
    if (!SHORT_RE.test(short) || short === 'default') return null;

    const diting = raw.diting && typeof raw.diting === 'object' ? raw.diting : {};
    const conf = raw.configuration && typeof raw.configuration === 'object' ? raw.configuration : null;

    return {
      short,
      id: short, // /api/public/themes 的历史契约字段（adminApi.ts:79 / SettingsView.vue:413）
      name: localized(raw.name) || short,
      description: localized(raw.description),
      version: typeof raw.version === 'string' ? raw.version : '',
      author: normalizeAuthor(raw.author),
      url: typeof raw.url === 'string' ? raw.url : '',
      preview: typeof raw.preview === 'string' ? raw.preview : '',
      configuration: conf && conf.type === 'managed' ? conf : null,
      diting: {
        compatibility: typeof diting.compatibility === 'string' ? diting.compatibility : '',
        needsRelaxedCsp: diting.needsRelaxedCsp === true
      },
      manifestFile: file,
      // manifest.json 是旧格式（komari 早期 / 自研 demo）：version/compatibility 校验按豁免处理
      legacy: file === 'manifest.json',
      bundled: !!bundled,
      dir
    };
  }
  return null;
}

/** 校验 short 合法性（不访问文件系统）。 */
const isValidShort = (short) => typeof short === 'string' && SHORT_RE.test(short) && short !== 'default';

/**
 * 解析主题目录：安装目录优先 → 内置目录。未找到返回 null。
 * 返回 { dir, bundled }。
 */
function resolveThemeDir(short) {
  if (!isValidShort(short)) return null;
  const installed = path.join(INSTALLED_THEMES_DIR, short);
  try {
    if (fs.statSync(installed).isDirectory()) return { dir: installed, bundled: false };
  } catch (e) { /* 未安装 */ }
  const bundled = path.join(BUNDLED_THEMES_DIR, short);
  try {
    if (fs.statSync(bundled).isDirectory()) return { dir: bundled, bundled: true };
  } catch (e) { /* 非内置 */ }
  return null;
}

function hasIndexHtml(dir) {
  try { return fs.statSync(path.join(dir, 'index.html')).isFile(); } catch (e) { return false; }
}

/**
 * 列出全部可用主题（安装 + 内置），安装版覆盖同名内置版。
 * 跳过：非目录、README 等散文件、`.bak-<ts>` 备份目录、default（SPA 自带皮肤）。
 */
function listInstalledThemes() {
  ensureInstalledDir();
  const ui = db.getUiSettings();
  const seen = new Map();

  const scan = (root, bundled) => {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const short = ent.name;
      if (!isValidShort(short) || BACKUP_RE.test(short)) continue;
      if (seen.has(short)) continue; // 安装版优先
      const dir = path.join(root, short);
      const manifest = readManifest(dir, short, bundled);
      if (!manifest) continue;
      let installedAt = 0;
      try { installedAt = fs.statSync(dir).mtimeMs; } catch (e) { /* 忽略 */ }
      seen.set(short, {
        ...manifest,
        installed_at: Math.round(installedAt),
        enabled: ui.public_theme === short,
        configurable: !!manifest.configuration
      });
    }
  };

  scan(INSTALLED_THEMES_DIR, false);
  scan(BUNDLED_THEMES_DIR, true);
  return Array.from(seen.values()).sort((a, b) => a.short.localeCompare(b.short));
}

/** 读取单个主题的归一化 manifest；找不到返回 null。 */
function getTheme(short) {
  const found = resolveThemeDir(short);
  if (!found) return null;
  const manifest = readManifest(found.dir, short, found.bundled);
  if (!manifest) return null;
  const ui = db.getUiSettings();
  return {
    ...manifest,
    enabled: ui.public_theme === short,
    configurable: !!manifest.configuration
  };
}

/**
 * 启用主题：写 ui_settings.public_theme 并刷新 nonce 集合。
 * 只接受已安装/内置的合法主题；切换回默认皮肤请直接改 ui_settings。
 */
function setEnabled(short) {
  if (!isValidShort(short)) {
    throw Object.assign(new Error('invalid theme short'), { code: 'theme_invalid_short' });
  }
  const found = resolveThemeDir(short);
  if (!found) {
    throw Object.assign(new Error('theme not found'), { code: 'theme_not_found' });
  }
  if (!hasIndexHtml(found.dir)) {
    throw Object.assign(new Error('theme has no index.html'), { code: 'theme_broken' });
  }
  const ui = db.getUiSettings();
  ui.public_theme = short;
  db.setUiSettings(ui);
  rebuildNonceSet();
  return { enabled: short };
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

/**
 * 备份主题目录到 BACKUP_DIR（不在 themes 内），保留最近 3 份。
 * 返回备份目录名（如 `aurora.bak-1792560000000`）。
 */
function backupTheme(short) {
  const found = resolveThemeDir(short);
  if (!found) throw Object.assign(new Error('theme not found'), { code: 'theme_not_found' });
  if (found.bundled) throw Object.assign(new Error('bundled theme is read-only'), { code: 'theme_bundled_readonly' });

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `${short}.bak-${Date.now()}`;
  fs.cpSync(found.dir, path.join(BACKUP_DIR, name), { recursive: true });

  // 只保留该 short 最近 3 份备份
  const prefix = `${short}.bak-`;
  let backups = [];
  try {
    backups = fs.readdirSync(BACKUP_DIR)
      .filter((n) => n.startsWith(prefix) && BACKUP_RE.test(n))
      .map((n) => ({ n, ts: Number(n.slice(prefix.length)) || 0 }))
      .sort((a, b) => b.ts - a.ts);
  } catch (e) { /* 忽略 */ }
  for (const old of backups.slice(3)) rmrf(path.join(BACKUP_DIR, old.n));
  return name;
}

/** 从备份恢复；备份名必须属于该 short。 */
function restoreBackup(short, backupName) {
  if (!isValidShort(short)) {
    throw Object.assign(new Error('invalid theme short'), { code: 'theme_invalid_short' });
  }
  const name = String(backupName || '');
  if (!name.startsWith(`${short}.bak-`) || !BACKUP_RE.test(name)) {
    throw Object.assign(new Error('invalid backup name'), { code: 'theme_backup_invalid' });
  }
  const src = path.join(BACKUP_DIR, name);
  try {
    if (!fs.statSync(src).isDirectory()) throw new Error('not a dir');
  } catch (e) {
    throw Object.assign(new Error('backup not found'), { code: 'theme_backup_not_found' });
  }
  const dest = path.join(INSTALLED_THEMES_DIR, short);
  rmrf(dest);
  fs.cpSync(src, dest, { recursive: true });
  if (!readManifest(dest, short, false)) {
    rmrf(dest);
    throw Object.assign(new Error('backup manifest invalid'), { code: 'theme_backup_invalid' });
  }
  rebuildNonceSet();
  return getTheme(short);
}

/** 列出某主题的备份（新→旧），供管理端回滚选择。 */
function listBackups(short) {
  if (!isValidShort(short)) return [];
  const prefix = `${short}.bak-`;
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((n) => n.startsWith(prefix) && BACKUP_RE.test(n))
      .map((n) => ({
        name: n,
        created_at: Number(n.slice(prefix.length)) || 0,
        size: (() => { try { return fs.statSync(path.join(BACKUP_DIR, n)).size; } catch (e) { return 0; } })()
      }))
      .sort((a, b) => b.created_at - a.created_at);
  } catch (e) { return []; }
}

/** 读取目录下的原始 manifest（严格校验场景需要未归一化的字段）。 */
function readRawManifest(dir) {
  for (const file of MANIFEST_FILES) {
    const raw = readManifestFile(path.join(dir, file));
    if (raw) return { file, raw };
  }
  return null;
}

/**
 * 删除已安装主题。内置主题只读，拒绝删除。
 * 副作用：删的是当前启用主题 → 回退 public_theme='default'；清理其配置；刷新 nonce 集合。
 */
function deleteTheme(short) {
  if (!isValidShort(short)) {
    throw Object.assign(new Error('invalid theme short'), { code: 'theme_invalid_short' });
  }
  const installedDir = path.join(INSTALLED_THEMES_DIR, short);
  let exists = false;
  try { exists = fs.statSync(installedDir).isDirectory(); } catch (e) { exists = false; }
  if (!exists) {
    const bundled = resolveThemeDir(short);
    throw Object.assign(
      new Error(bundled && bundled.bundled ? 'bundled theme is read-only' : 'theme not found'),
      { code: bundled && bundled.bundled ? 'theme_bundled_readonly' : 'theme_not_found' }
    );
  }

  const ui = db.getUiSettings();
  const wasEnabled = ui.public_theme === short;
  rmrf(installedDir);
  if (wasEnabled) {
    ui.public_theme = 'default';
    db.setUiSettings(ui);
  }
  db.deleteThemeConfig(short);
  rebuildNonceSet();
  return { deleted: true, fallbackTheme: wasEnabled ? 'default' : null };
}

// ---- CSP nonce 集合 --------------------------------------------------------
// 必须原地 clear/add：server.js 持有的是同一个 Set 引用。
const themeNonceSet = new Set();

/** 扫安装 + 内置主题，重建 needsRelaxedCsp 集合（原地修改）。 */
function rebuildNonceSet() {
  themeNonceSet.clear();
  const scan = (root, bundled) => {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() || BACKUP_RE.test(ent.name) || !isValidShort(ent.name)) continue;
      const m = readManifest(path.join(root, ent.name), ent.name, bundled);
      if (m && m.diting.needsRelaxedCsp) themeNonceSet.add(m.short);
    }
  };
  scan(INSTALLED_THEMES_DIR, false);
  scan(BUNDLED_THEMES_DIR, true);
  return themeNonceSet;
}

module.exports = {
  INSTALLED_THEMES_DIR,
  BUNDLED_THEMES_DIR,
  BACKUP_DIR,
  SHORT_RE,
  isValidShort,
  localized,
  readManifest,
  readRawManifest,
  resolveThemeDir,
  listInstalledThemes,
  getTheme,
  setEnabled,
  deleteTheme,
  backupTheme,
  restoreBackup,
  listBackups,
  hasIndexHtml,
  themeNonceSet,
  rebuildNonceSet
};
