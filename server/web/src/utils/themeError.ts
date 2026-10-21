import { t } from '../composables/useI18n';

// S5/F10 主题市场错误码 → 本地化文案键的映射。
//
// 背景：服务端 themeError() 返回 { error: '<code>', message: '<英文兜底>' }，
// services/api.ts 已把 error 字段挂到 Error.detail 上；来源列表里的 s.error 则是裸 code。
// 这里统一把机器码翻译成「可操作」的提示，避免把 insecure_scheme 这类码直接甩给用户。
// 导出仅供单测做「映射键 ↔ i18n 词典」一致性校验（见 utils/themeError.test.ts）。
export const THEME_ERROR_CODE_KEYS: Record<string, string> = {
  // 来源 / URL 校验
  name_required: 'theme.err.nameRequired',
  url_invalid: 'theme.err.urlInvalid',
  scheme_invalid: 'theme.err.schemeInvalid',
  url_scheme_invalid: 'theme.err.schemeInvalid',
  insecure_scheme: 'theme.err.insecureScheme',
  url_userinfo_forbidden: 'theme.err.userinfoForbidden',
  source_url_conflict: 'theme.err.sourceUrlConflict',
  source_not_found: 'theme.err.sourceNotFound',
  blocked_target: 'theme.err.blockedTarget',
  dns_failed: 'theme.err.dnsFailed',
  dns_empty: 'theme.err.dnsFailed',
  http_redirect: 'theme.err.redirect',
  http_403: 'theme.err.http403',
  http_404: 'theme.err.notFound',
  timeout: 'theme.err.timeout',
  too_large: 'theme.err.tooLarge',
  download_failed: 'theme.err.downloadFailed',

  // 主题标识 / 配置
  short_invalid: 'theme.err.shortInvalid',
  theme_invalid_short: 'theme.err.shortInvalid',
  config_invalid: 'theme.err.configInvalid',
  config_key_unknown: 'theme.err.configInvalid',
  config_value_invalid: 'theme.err.configValueInvalid',
  config_value_too_long: 'theme.err.configValueTooLong',
  config_value_required: 'theme.err.configValueRequired',
  not_configurable: 'theme.err.notConfigurable',

  // catalog / GitHub
  catalog_invalid_json: 'theme.err.catalogInvalid',
  catalog_fetch_failed: 'theme.err.catalogInvalid',
  github_invalid_json: 'theme.err.githubInvalid',
  no_zip_asset: 'theme.err.noZipAsset',
  theme_not_in_catalog: 'theme.err.notInCatalog',
  theme_not_installable: 'theme.err.notInstallable',

  // 安装包
  theme_sha256_mismatch: 'theme.err.shaMismatch',
  theme_zip_invalid: 'theme.err.zipInvalid',
  theme_zip_empty: 'theme.err.zipInvalid',
  theme_zip_corrupt: 'theme.err.zipInvalid',
  theme_zip_compression_unsupported: 'theme.err.zipInvalid',
  zip_unsafe_path: 'theme.err.zipUnsafe',
  theme_zip_symlink_forbidden: 'theme.err.zipUnsafe',
  theme_zip_too_large: 'theme.err.zipTooLarge',
  theme_zip_too_many_files: 'theme.err.zipTooLarge',
  theme_manifest_missing: 'theme.err.manifestMissing',
  theme_manifest_invalid: 'theme.err.manifestInvalid',
  theme_short_mismatch: 'theme.err.manifestMismatch',
  theme_version_mismatch: 'theme.err.manifestMismatch',
  theme_incompatible: 'theme.err.incompatible',

  // 本地主题操作
  theme_not_found: 'theme.err.themeNotFound',
  theme_broken: 'theme.err.themeBroken',
  theme_bundled_readonly: 'theme.err.bundledReadonly',
  theme_backup_invalid: 'theme.err.backupInvalid',
  theme_backup_not_found: 'theme.err.backupNotFound',
  update_source_required: 'theme.err.updateSourceRequired',
  theme_failed: 'theme.err.failed'
};

// 把来源错误 / 请求异常转成可展示文案：
//   1. 已知错误码 → 本地化提示；
//   2. http_<3位状态码> → 通用 HTTP 提示（带状态码）；
//   3. 未知但形似错误码（无空格）→ 带原码的兜底；
//   4. 其余（如网关返回的 "502 Bad Gateway"）原样展示。
export function themeErrorMessage(input: unknown): string {
  const err = (input || {}) as Error & { detail?: string };
  const raw = typeof input === 'string' ? input : (err.detail || err.message || '');
  // adminApi 会把错误拼成 "code (HTTP 400)"，这里剥掉状态码后缀
  const code = String(raw).replace(/\s*\(HTTP \d+\)\s*$/, '').trim();
  if (!code) return t('theme.actionFailed');

  const key = THEME_ERROR_CODE_KEYS[code];
  if (key) return t(key);

  const http = /^http_(\d{3})$/.exec(code);
  if (http) return t('theme.err.http', { status: http[1] });

  if (/\s/.test(code)) return code;
  return t('theme.err.unknown', { code });
}
