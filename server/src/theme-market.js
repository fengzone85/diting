'use strict';

/**
 * S5/F10 主题市场：catalog 拉取、ZIP 下载与安全解压、安装/导入/更新/回滚。
 *
 * 安全边界：
 * - 下载不复用 notify 的 requestOnce（4KB/10s/仅空体），本文件自建 safeDownload，
 *   复用 notify._internal 的 parseTarget / resolveHost / isBlockedIP 做 SSRF 防护；
 * - ZIP 按 entry 逐个解压，单文件/总量按实际字节封顶（不信任 header 声明的 size）；
 * - 拒绝路径穿越、绝对路径、符号链接条目；
 * - 安装过程串行（单飞锁），临时目录必清理。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('node:http');
const https = require('node:https');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const db = require('./db');
const theme = require('./theme');
const validate = require('./validate');
const notify = require('./notify');

const { parseTarget, resolveHost, pinnedLookup } = notify._internal;
const APP_VERSION = require('../package.json').version;

const CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const PACKAGE_MAX_BYTES = 100 * 1024 * 1024;
const ZIP_MAX_FILES = 10000;
const ZIP_MAX_FILE_BYTES = 128 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const CACHE_TTL_MS = 10 * 60 * 1000;

function fail(code, message) {
  return Object.assign(new Error(message || code), { code });
}

// ---- 安全下载 ---------------------------------------------------------------
/**
 * GET 下载一个 URL，钉住 DNS 解析结果，禁止重定向，限制响应体大小。
 * 与 notify 的 SSRF 规则一致：ALLOW_INSECURE_WEBHOOK=1 放行 http，
 * ALLOW_PRIVATE_WEBHOOK=1 放行私网（局域网自建市场源）。
 */
async function safeDownload(urlStr, opts = {}) {
  const maxBytes = opts.maxBytes || PACKAGE_MAX_BYTES;
  const timeoutMs = opts.timeoutMs || DOWNLOAD_TIMEOUT_MS;
  // notify.parseTarget / resolveHost 的历史错误只带 message（无 code）：
  // 统一转成带 code 的失败，供 API 层映射 HTTP 状态。
  let target;
  try {
    target = parseTarget(urlStr, {
      method: 'GET',
      headers: Object.assign({ 'User-Agent': 'diting-theme-market/1.0', Accept: '*/*' }, opts.headers || {})
    });
  } catch (e) {
    throw fail((e && e.message) || 'url_invalid');
  }
  // IPv6 字面量在 URL.hostname 中带方括号，DNS 解析与 http.request 均需去掉。
  const hostname = String(target.hostname || '').replace(/^\[(.*)\]$/, '$1');
  let pinned;
  try {
    pinned = await resolveHost(hostname);
  } catch (e) {
    throw fail((e && e.message) || 'dns_failed');
  }
  const isHttps = target.protocol === 'https:';
  const mod = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: target.protocol,
      hostname,
      port: Number(target.port),
      path: target.path,
      method: 'GET',
      headers: target.headers,
      timeout: timeoutMs,
      agent: false,
      rejectUnauthorized: target.verify_tls !== false,
      lookup: pinnedLookup(pinned.ip, pinned.family)
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400) {
        res.resume();
        return reject(fail('http_redirect', `redirect_not_allowed_${code}`));
      }
      if (code < 200 || code >= 300) {
        res.resume();
        return reject(fail(`http_${code}`));
      }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared && declared > maxBytes) {
        res.destroy();
        return reject(fail('too_large'));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          reject(fail('too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (e) => reject(e));
    });
    req.on('timeout', () => req.destroy(fail('timeout')));
    req.on('error', (e) => reject(e.code ? e : fail('download_failed', e.message)));
    req.end();
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- catalog ----------------------------------------------------------------
const cache = new Map(); // url -> { data, expiresAt }

/** 归一化 sha256：允许 `sha256:` 前缀与大小写。 */
function normalizeSha(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(s) ? s : '';
}

function parseCatalog(json, source) {
  // 相对地址按 catalog 自身 URL 解析为绝对地址（download 直接影响安装，preview/主页仅展示）。
  const abs = (v) => {
    if (typeof v !== 'string' || !v) return '';
    try { return new URL(v, source.url).toString(); } catch (e) { return ''; }
  };
  const list = Array.isArray(json) ? json
    : (json && Array.isArray(json.themes)) ? json.themes
      : (json && typeof json === 'object' && (json.short || json.id)) ? [json]
        : [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const short = String(raw.short || raw.id || '');
    if (!theme.isValidShort(short)) continue;
    const sha = normalizeSha(raw.sha256);
    const download = abs(raw.download);
    out.push({
      short,
      name: theme.localized(raw.name) || short,
      description: theme.localized(raw.description),
      version: typeof raw.version === 'string' ? raw.version : '',
      author: typeof raw.author === 'string' ? raw.author
        : theme.localized(raw.author && raw.author.name),
      url: abs(raw.url),
      preview: abs(raw.preview),
      download,
      sha256: sha,
      // catalog 显式 false 或缺少 download/sha256 都视为不可安装（仅可跳转主页）
      installable: raw.installable !== false && !!download && !!sha,
      source_id: source.id,
      source_name: source.name
    });
  }
  return out;
}

async function fetchCatalog(source, force = false) {
  const url = source.url;
  const now = Date.now();
  const hit = cache.get(url);
  if (!force && hit && hit.expiresAt > now) return hit.data;
  const buf = await safeDownload(url, { maxBytes: CATALOG_MAX_BYTES, timeoutMs: CATALOG_TIMEOUT_MS });
  let json;
  try { json = JSON.parse(buf.toString('utf8')); }
  catch (e) { throw fail('catalog_invalid_json'); }
  const data = { themes: parseCatalog(json, source), fetched_at: now };
  cache.set(url, { data, expiresAt: now + CACHE_TTL_MS });
  return data;
}

/** 源增删改后清缓存（url 变更时新旧都要清）。 */
function invalidateCatalog(url) {
  if (url) cache.delete(String(url));
}

/** 聚合所有启用源；单个源失败不影响其它源。 */
async function listMarketThemes(force = false) {
  const sources = db.listThemeMarketSources().filter((s) => s.enabled);
  const settled = await Promise.allSettled(sources.map((s) => fetchCatalog(s, force)));
  const themes = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') themes.push(...r.value.themes);
    else errors.push({ source_id: sources[i].id, source_name: sources[i].name, error: r.reason && r.reason.code ? r.reason.code : 'catalog_failed' });
  });
  return { themes, errors, sources: sources.length };
}

// ---- GitHub release ---------------------------------------------------------
function parseGitHubRepo(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return null; }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length < 2) return null;
  const [owner, repo] = seg;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo: repo.replace(/\.git$/, '') };
}

/**
 * 把仓库 URL 解析成可下载的 ZIP：
 * - 已是 ZIP / release asset（.zip）则原样返回；
 * - github.com/<owner>/<repo> → latest release 中第一个文件名以 .zip 结尾的 asset；
 * - 无 zip asset → 404 no_zip_asset（不盲取 assets[0]）。
 */
async function resolveDownloadUrl(urlStr) {
  if (/\.zip(\?|$)/i.test(urlStr)) return urlStr;
  const repo = parseGitHubRepo(urlStr);
  if (!repo) return urlStr;
  const api = `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`;
  const buf = await safeDownload(api, {
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: CATALOG_TIMEOUT_MS,
    headers: { Accept: 'application/vnd.github+json' }
  });
  let rel;
  try { rel = JSON.parse(buf.toString('utf8')); }
  catch (e) { throw fail('github_invalid_json'); }
  const asset = (Array.isArray(rel.assets) ? rel.assets : [])
    .find((a) => a && typeof a.browser_download_url === 'string' && /\.zip(\?|$)/i.test(a.browser_download_url));
  if (!asset) throw fail('no_zip_asset');
  return asset.browser_download_url;
}

// ---- semver（仅支持安装期 compatibility 判断所需的最小集合）------------------
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return true; // 无法解析的版本不放行也不误杀：交由安装者自行判断
  const r = String(range || '').trim();
  if (!r) return true;
  return r.split(/\s+/).filter(Boolean).every((part) => {
    const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(part);
    if (!m) return true;
    const op = m[1] || '>=';
    const t = [Number(m[2]), Number(m[3] || 0), Number(m[4] || 0)];
    if (op === '^') return v[0] === t[0] && cmpVersion(v, t) >= 0;
    if (op === '~') return v[0] === t[0] && v[1] === t[1] && cmpVersion(v, t) >= 0;
    const c = cmpVersion(v, t);
    if (op === '>') return c > 0;
    if (op === '<') return c < 0;
    if (op === '<=') return c <= 0;
    if (op === '=') return c === 0;
    return c >= 0;
  });
}

// ---- ZIP 安全解压 -----------------------------------------------------------
function normalizeEntryName(name) {
  return String(name || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function assertSafeEntryName(name) {
  if (!name || name === '/') return false;
  if (name.includes('\0')) throw fail('zip_unsafe_path');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw fail('zip_unsafe_path');
  if (name.split('/').some((seg) => seg === '..')) throw fail('zip_unsafe_path');
  return true;
}

function entryMode(entry) {
  const attr = Number(entry.header && entry.header.attr) || 0;
  return (attr >>> 16) & 0xFFFF;
}

/** 读出一个 entry 的解压数据，用 maxOutputLength 硬顶住伪造 size 的 bomb。 */
function readEntryData(entry, limit) {
  const method = Number(entry.header && entry.header.method);
  const compressed = entry.getCompressedData();
  if (method === 0) {
    if (compressed.length > limit) throw fail('theme_zip_too_large');
    return compressed;
  }
  if (method !== 8) throw fail('theme_zip_compression_unsupported');
  try {
    return zlib.inflateRawSync(compressed, { maxOutputLength: limit });
  } catch (e) {
    if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength/i.test(String(e.message)))) {
      throw fail('theme_zip_too_large');
    }
    throw fail('theme_zip_corrupt');
  }
}

/**
 * 校验并解压 ZIP 到 dest（调用方保证 dest 是新建临时目录）。
 * 返回 { files, bytes }。
 */
function extractZip(buf, dest) {
  let zip;
  try { zip = new AdmZip(buf); } catch (e) { throw fail('theme_zip_invalid'); }
  let entries;
  try { entries = zip.getEntries(); } catch (e) { throw fail('theme_zip_invalid'); }
  if (!entries.length) throw fail('theme_zip_empty');
  if (entries.length > ZIP_MAX_FILES) throw fail('theme_zip_too_many_files');

  // 第一遍：结构校验（不落盘）
  let declaredTotal = 0;
  for (const entry of entries) {
    const name = normalizeEntryName(entry.entryName);
    if (!assertSafeEntryName(name)) continue;
    const mode = entryMode(entry);
    const fileType = mode & 0xF000;
    // 0xA000 = symlink；符号链接一旦落盘，静态路由可把 /themes/<short>/x 指向任意文件。
    if (fileType === 0xA000) throw fail('theme_zip_symlink_forbidden');
    if (entry.isDirectory || name.endsWith('/')) continue;
    const size = Number(entry.header && entry.header.size) || 0;
    if (size > ZIP_MAX_FILE_BYTES) throw fail('theme_zip_too_large');
    declaredTotal += size;
    if (declaredTotal > ZIP_MAX_TOTAL_BYTES) throw fail('theme_zip_too_large');
  }

  // 第二遍：逐 entry 解压，按实际字节再封顶一次
  let actualTotal = 0;
  let files = 0;
  for (const entry of entries) {
    const name = normalizeEntryName(entry.entryName);
    if (!assertSafeEntryName(name)) continue;
    if (entry.isDirectory || name.endsWith('/')) continue;

    const fp = path.resolve(dest, name);
    if (!fp.startsWith(dest + path.sep)) throw fail('zip_unsafe_path');

    const data = readEntryData(entry, ZIP_MAX_FILE_BYTES);
    actualTotal += data.length;
    if (actualTotal > ZIP_MAX_TOTAL_BYTES) throw fail('theme_zip_too_large');

    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, data);
    files++;
  }
  if (!files) throw fail('theme_zip_empty');

  // 第三遍：复核落盘结果无符号链接（防御未来解压实现变化）
  try {
    for (const ent of fs.readdirSync(dest, { recursive: true, withFileTypes: true })) {
      if (ent.isSymbolicLink()) throw fail('theme_zip_symlink_forbidden');
    }
  } catch (e) {
    if (e && e.code === 'theme_zip_symlink_forbidden') throw e;
    // readdir recursive 在旧 Node 上不支持：忽略
  }
  return { files, bytes: actualTotal };
}

// ---- 安装 -------------------------------------------------------------------
// 单飞锁：同时只允许一个安装/导入/更新任务，避免并发解压叠加内存峰值。
let installChain = Promise.resolve();
function withInstallLock(fn) {
  const run = installChain.then(fn, fn);
  installChain = run.then(() => undefined, () => undefined);
  return run;
}

function verifyCompatibility(manifest) {
  if (manifest.legacy) return; // 旧格式 manifest.json 无 diting 字段，豁免
  const range = manifest.diting && manifest.diting.compatibility;
  if (range && !satisfies(APP_VERSION, range)) {
    throw fail('theme_incompatible', `requires ${range}, current ${APP_VERSION}`);
  }
}

/**
 * 从 ZIP 缓冲区安装/覆盖一个主题。
 * @param {Buffer} buf
 * @param {object} expect { short, version, sha256 }（catalog 场景；导入场景可为空）
 */
async function installFromZip(buf, expect = {}) {
  return withInstallLock(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-theme-'));
    try {
      extractZip(buf, tmp);

      const found = theme.readRawManifest(tmp);
      if (!found) throw fail('theme_manifest_missing');
      const checked = validate.validateManifest(found.raw);
      if (!checked.ok) throw fail(checked.error);

      const manifest = theme.readManifest(tmp, checked.value.short, false);
      if (!manifest) throw fail('theme_manifest_invalid');

      if (expect.short && manifest.short !== expect.short) {
        throw fail('theme_short_mismatch', `expected ${expect.short}, got ${manifest.short}`);
      }
      const isLegacy = found.file === 'manifest.json';
      if (!isLegacy && expect.version && manifest.version && manifest.version !== expect.version) {
        throw fail('theme_version_mismatch', `expected ${expect.version}, got ${manifest.version}`);
      }
      verifyCompatibility(manifest);

      const dest = path.join(theme.INSTALLED_THEMES_DIR, manifest.short);
      fs.mkdirSync(theme.INSTALLED_THEMES_DIR, { recursive: true });
      let existing = false;
      try { existing = fs.statSync(dest).isDirectory(); } catch (e) { existing = false; }
      if (existing) theme.backupTheme(manifest.short);

      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(tmp, dest, { recursive: true });
      theme.rebuildNonceSet();
      return theme.getTheme(manifest.short);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
  });
}

async function installFromMarket(sourceId, short) {
  const vs = validate.validateThemeShort(short);
  if (!vs.ok) throw fail(vs.error);
  const source = db.getThemeMarketSource(sourceId);
  if (!source || !source.enabled) throw fail('source_not_found');

  const catalog = await fetchCatalog(source, true);
  const entry = catalog.themes.find((t) => t.short === short);
  if (!entry) throw fail('theme_not_in_catalog');
  if (!entry.installable) throw fail('theme_not_installable');

  const buf = await safeDownload(entry.download, { maxBytes: PACKAGE_MAX_BYTES });
  const digest = sha256(buf);
  if (digest !== entry.sha256) throw fail('theme_sha256_mismatch');
  return installFromZip(buf, { short: entry.short, version: entry.version });
}

/** 导入任意 URL（ZIP 或 GitHub 仓库）。preview=true 只解析 manifest 不安装。 */
async function importFromURL(urlStr, preview = false) {
  if (typeof urlStr !== 'string' || !urlStr) throw fail('url_invalid');
  const downloadUrl = await resolveDownloadUrl(urlStr);

  if (preview) {
    const buf = await safeDownload(downloadUrl, { maxBytes: PACKAGE_MAX_BYTES });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-theme-preview-'));
    try {
      extractZip(buf, tmp);
      const found = theme.readRawManifest(tmp);
      if (!found) throw fail('theme_manifest_missing');
      const checked = validate.validateManifest(found.raw);
      if (!checked.ok) throw fail(checked.error);
      const manifest = theme.readManifest(tmp, checked.value.short, false);
      if (!manifest) throw fail('theme_manifest_invalid');
      verifyCompatibility(manifest);
      return { manifest, exists: !!theme.resolveThemeDir(manifest.short) };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
  }

  const buf = await safeDownload(downloadUrl, { maxBytes: PACKAGE_MAX_BYTES });
  return installFromZip(buf, {});
}

/**
 * 更新已安装主题：
 * 优先级 url > git_owner+git_repo > manifest.url。
 * 内置主题只读，拒绝更新。
 */
async function updateTheme(short, opts = {}) {
  const vs = validate.validateThemeShort(short);
  if (!vs.ok) throw fail(vs.error);
  const found = theme.resolveThemeDir(short);
  if (!found) throw fail('theme_not_found');
  if (found.bundled) throw fail('theme_bundled_readonly');

  const current = theme.getTheme(short);
  let target = '';
  if (typeof opts.url === 'string' && opts.url) {
    target = opts.url;
  } else if (opts.git_owner && opts.git_repo) {
    if (!/^[A-Za-z0-9_.-]+$/.test(opts.git_owner) || !/^[A-Za-z0-9_.-]+$/.test(opts.git_repo)) {
      throw fail('url_invalid');
    }
    target = `https://github.com/${opts.git_owner}/${opts.git_repo}`;
  } else if (current && current.url) {
    target = current.url;
  }
  if (!target) throw fail('update_source_required');

  return importFromURL(target, false);
}

/** 从备份恢复（备份名由 GET /api/admin/theme/backups 提供）。 */
function rollbackTheme(short, backupName) {
  return theme.restoreBackup(short, backupName);
}

module.exports = {
  // 常量（测试用）
  ZIP_MAX_FILES, ZIP_MAX_FILE_BYTES, ZIP_MAX_TOTAL_BYTES, PACKAGE_MAX_BYTES, CATALOG_MAX_BYTES,
  // 下载 / catalog
  safeDownload, sha256, fetchCatalog, listMarketThemes, invalidateCatalog,
  // 安装
  installFromMarket, installFromZip, importFromURL, updateTheme, rollbackTheme,
  // 解析 / 解压（测试用）
  parseCatalog, extractZip, resolveDownloadUrl, satisfies,
  // 内部缓存（测试用）
  _cache: cache
};
