'use strict';
// /admin/theme/* 管理路由（P2-1 拆分第一域）。
//
// 路由保留完整路径（'/admin/theme/...'），主文件用 router.use(adminThemeRoutes) 平铺挂载，
// 不额外加前缀——拆分不改变任何对外路径，路由快照可直接逐条比对。
//
// 依赖方向：本文件 → theme / theme-market / db / validate / auth / _shared，不得反向 require api.js。

const express = require('express');
const theme = require('../theme');
const themeMarket = require('../theme-market');
const db = require('../db');
const validators = require('../validate');
const { adminOnly, adminOrReadonly, agentScope, auditLog } = require('../auth');
const { asyncHandler } = require('../util');
const { agentGlobalOnly } = require('./_shared');

const router = express.Router();

// ---- S5/F10：主题市场 ------------------------------------------------------
// 错误码 → HTTP 状态。未列出的 http_<code> 统一 502（上游异常）。
const THEME_HTTP_STATUS = {
  short_invalid: 400, name_required: 400, url_invalid: 400, url_scheme_invalid: 400,
  url_userinfo_forbidden: 400, config_invalid: 400, not_configurable: 400,
  config_key_unknown: 400, config_value_invalid: 400, config_value_too_long: 400,
  config_value_required: 400, theme_invalid_short: 400, theme_backup_invalid: 400,
  update_source_required: 400, scheme_invalid: 400, insecure_scheme: 400, blocked_target: 400,
  source_not_found: 404, theme_not_found: 404, theme_backup_not_found: 404,
  theme_not_in_catalog: 404, no_zip_asset: 404,
  source_url_conflict: 409, theme_broken: 409, theme_bundled_readonly: 409,
  theme_incompatible: 409, theme_not_installable: 409,
  too_large: 413, theme_zip_too_large: 413, theme_zip_too_many_files: 413,
  theme_manifest_missing: 422, theme_manifest_invalid: 422, theme_short_mismatch: 422,
  theme_version_mismatch: 422, theme_sha256_mismatch: 422, theme_zip_invalid: 422,
  theme_zip_empty: 422, theme_zip_corrupt: 422, theme_zip_compression_unsupported: 422,
  theme_zip_symlink_forbidden: 422, zip_unsafe_path: 422,
  http_redirect: 502, download_failed: 502, catalog_invalid_json: 502,
  catalog_fetch_failed: 502, github_invalid_json: 502, dns_failed: 502, dns_empty: 502,
  timeout: 504
};

function themeError(res, e) {
  const code = (e && e.code) || 'theme_failed';
  const status = THEME_HTTP_STATUS[code] || (code.startsWith('http_') ? 502 : 500);
  if (status >= 500) console.error('[theme]', code, e && e.message);
  res.status(status).json({
    error: code,
    message: e && e.message ? String(e.message).slice(0, 200) : ''
  });
}

// 主题管理路由共用：业务错误转成带状态码的 JSON，未知错误不吞（交给全局处理器）。
function themeRoute(fn) {
  return asyncHandler(async (req, res) => {
    try { await fn(req, res); } catch (e) { themeError(res, e); }
  });
}

const themeShortArg = (v) => (typeof v === 'string' ? v.trim() : '');
// manifest 里的 configuration 是原始 data 形态；配置端点统一转成校验后的 fields 形态。
const themeConfigurationOf = (short) => {
  const t = theme.getTheme(short);
  if (!t || !t.configuration) return null;
  const checked = validators.validateManifest({ short, name: t.name, configuration: t.configuration });
  return checked.ok ? checked.value.configuration : null;
};

router.get('/admin/theme/list', adminOrReadonly, agentScope, (req, res) => {
  res.json(theme.listInstalledThemes().map((t) => ({
    short: t.short,
    id: t.short,
    name: t.name,
    description: t.description,
    version: t.version,
    author: t.author,
    url: t.url,
    preview: t.preview,
    configuration: t.configuration,
    diting: t.diting,
    installed_at: t.installed_at,
    enabled: t.enabled,
    configurable: t.configurable,
    bundled: t.bundled,
    manifest_file: t.manifestFile,
    legacy: t.legacy
  })));
});

router.get('/admin/theme/market/sources', adminOrReadonly, agentScope, (req, res) => {
  res.json(db.listThemeMarketSources());
});

router.post('/admin/theme/market/sources', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const v = validators.validateThemeMarketSource(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const exists = db.listThemeMarketSources().find((s) => s.url === v.value.url);
  if (exists) return res.status(409).json({ error: 'source_url_conflict', id: exists.id });
  const created = db.createThemeMarketSource(v.value);
  themeMarket.invalidateCatalog(created.url);
  auditLog(req, 'theme_action', `op=source_create id=${created.id} url=${created.url}`);
  res.json(created);
});

router.put('/admin/theme/market/sources/:id', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const cur = db.getThemeMarketSource(req.params.id);
  if (!cur) return res.status(404).json({ error: 'source_not_found' });
  const b = req.body || {};
  const v = validators.validateThemeMarketSource({
    name: b.name !== undefined ? b.name : cur.name,
    url: b.url !== undefined ? b.url : cur.url,
    enabled: b.enabled !== undefined ? b.enabled : cur.enabled
  });
  if (!v.ok) return res.status(400).json({ error: v.error });
  const conflict = db.listThemeMarketSources().find((s) => s.id !== cur.id && s.url === v.value.url);
  if (conflict) return res.status(409).json({ error: 'source_url_conflict', id: conflict.id });
  const next = db.updateThemeMarketSource(cur.id, v.value);
  themeMarket.invalidateCatalog(cur.url);
  if (next.url !== cur.url) themeMarket.invalidateCatalog(next.url);
  auditLog(req, 'theme_action', `op=source_update id=${next.id} enabled=${next.enabled}`);
  res.json(next);
});

router.delete('/admin/theme/market/sources/:id', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const cur = db.getThemeMarketSource(req.params.id);
  if (!cur) return res.status(404).json({ error: 'source_not_found' });
  db.deleteThemeMarketSource(cur.id);
  themeMarket.invalidateCatalog(cur.url);
  auditLog(req, 'theme_action', `op=source_delete id=${cur.id}`);
  res.json({ deleted: true });
});

router.get('/admin/theme/market/catalog', adminOrReadonly, agentScope, themeRoute(async (req, res) => {
  const force = req.query.refresh === '1' || req.query.refresh === 'true';
  const result = await themeMarket.listMarketThemes(force);
  const counts = new Map();
  for (const t of result.themes) counts.set(t.source_id, (counts.get(t.source_id) || 0) + 1);
  const sources = db.listThemeMarketSources()
    .filter((s) => s.enabled)
    .map((s) => {
      const err = result.errors.find((e) => e.source_id === s.id);
      return { id: s.id, name: s.name, count: counts.get(s.id) || 0, error: err ? err.error : null };
    });
  res.json({ themes: result.themes, sources });
}));

router.post('/admin/theme/market/install', adminOnly, agentScope, agentGlobalOnly, themeRoute(async (req, res) => {
  const b = req.body || {};
  const vs = validators.validateThemeShort(b.short);
  if (!vs.ok) return res.status(400).json({ error: vs.error });
  const source = db.getThemeMarketSource(b.source_id);
  if (!source) return res.status(404).json({ error: 'source_not_found' });
  const manifest = await themeMarket.installFromMarket(source.id, vs.value);
  auditLog(req, 'theme_action', `op=market_install short=${manifest.short} version=${manifest.version}`);
  res.json({ manifest, installed_at: Date.now() });
}));

router.post('/admin/theme/import', adminOnly, agentScope, agentGlobalOnly, themeRoute(async (req, res) => {
  const b = req.body || {};
  const preview = req.query.preview === '1' || req.query.preview === 'true' || b.preview === true;
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  const result = await themeMarket.importFromURL(url, preview);
  if (preview) return res.json(result);
  auditLog(req, 'theme_action', `op=import short=${result.short} version=${result.version}`);
  res.json({ manifest: result });
}));

router.post('/admin/theme/update', adminOnly, agentScope, agentGlobalOnly, themeRoute(async (req, res) => {
  const b = req.body || {};
  const vs = validators.validateThemeShort(b.short);
  if (!vs.ok) return res.status(400).json({ error: vs.error });
  const manifest = await themeMarket.updateTheme(vs.value, {
    url: typeof b.url === 'string' ? b.url.trim() : '',
    git_owner: typeof b.git_owner === 'string' ? b.git_owner.trim() : '',
    git_repo: typeof b.git_repo === 'string' ? b.git_repo.trim() : ''
  });
  auditLog(req, 'theme_action', `op=update short=${manifest.short} version=${manifest.version}`);
  res.json({ manifest });
}));

router.post('/admin/theme/rollback', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const b = req.body || {};
  const vs = validators.validateThemeShort(b.short);
  if (!vs.ok) return res.status(400).json({ error: vs.error });
  try {
    const manifest = themeMarket.rollbackTheme(vs.value, b.backup);
    auditLog(req, 'theme_action', `op=rollback short=${vs.value} backup=${String(b.backup || '')}`);
    res.json({ manifest });
  } catch (e) { themeError(res, e); }
});

router.get('/admin/theme/backups', adminOrReadonly, agentScope, (req, res) => {
  const short = themeShortArg(req.query.short);
  if (!theme.isValidShort(short)) return res.status(400).json({ error: 'short_invalid' });
  res.json(theme.listBackups(short));
});

router.post('/admin/theme/set', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const short = themeShortArg(req.body && req.body.theme);
  try {
    const result = theme.setEnabled(short);
    auditLog(req, 'theme_action', `op=set short=${short}`);
    res.json(result);
  } catch (e) { themeError(res, e); }
});

router.post('/admin/theme/delete', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const short = themeShortArg(req.body && req.body.short);
  try {
    const result = theme.deleteTheme(short);
    auditLog(req, 'theme_action', `op=delete short=${short} fallback=${result.fallbackTheme || ''}`);
    res.json(result);
  } catch (e) { themeError(res, e); }
});

router.get('/admin/theme/config', adminOrReadonly, agentScope, (req, res) => {
  const short = themeShortArg(req.query.theme);
  if (!theme.isValidShort(short)) return res.status(400).json({ error: 'short_invalid' });
  const configuration = themeConfigurationOf(short);
  if (!configuration) return res.status(400).json({ error: 'not_configurable' });
  res.json({
    theme: short,
    configuration,
    values: validators.mergeThemeConfig(configuration.fields, db.getThemeConfig(short))
  });
});

router.post('/admin/theme/config', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const short = themeShortArg(req.query.theme || (req.body && req.body.theme));
  if (!theme.isValidShort(short)) return res.status(400).json({ error: 'short_invalid' });
  const configuration = themeConfigurationOf(short);
  if (!configuration) return res.status(400).json({ error: 'not_configurable' });
  // 契约：body 就是 values 本身（{key: val, ...}）；theme 通过 query.theme 指定。
  // 不接受 { values: {...} } 包装——避免前端多包一层、服务端多解一层的冗余。
  const body = req.body || {};
  const v = validators.validateThemeConfig(configuration, body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const values = validators.mergeThemeConfig(configuration.fields, { ...db.getThemeConfig(short), ...v.value });
  db.setThemeConfig(short, values);
  auditLog(req, 'theme_action', `op=config short=${short} keys=${Object.keys(v.value).sort().join(',')}`);
  res.json({ saved: true, values });
});

module.exports = router;
