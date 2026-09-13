import { t } from '../composables/useI18n';

// 后端 error 码 → 本地化文案键的映射。
//
// 背景：服务端 API 统一返回 { error: '<code>', message?: '<中文兜底>' }，
// services/api.ts 已把 error 字段挂到 Error.detail 上（详见该文件 request()）。
// 这里做的是「机器可读码 → 本地化文案」的最后一步，避免把服务端原文直接甩给用户、
// 也避免各视图重复写死同一批判断。
// 导出仅供单测做「映射键 ↔ i18n 词典」一致性校验（见 utils/apiError.test.ts）
export const ERROR_CODE_KEYS: Record<string, string> = {
  server_url_not_configured: 'errors.serverUrlNotConfigured',
  https_required: 'errors.httpsRequired',
  already_initialized: 'errors.alreadyInitialized',
  unauthorized: 'errors.unauthorized',
  // 注意：键必须与服务端 auth.js:155 返回的原始 error 字符串逐字一致（含空格）——
  // 早期误写为 admin_required（下划线）导致该映射永不命中，403 只能落到通用兜底。
  'admin required': 'errors.adminRequired',
  'ip not allowed': 'errors.ipNotAllowed',
  // 2FA 已启用但本次会话未完成 TOTP 验证（服务端同时返回 need_totp:true）
  'totp required': 'errors.totpRequired',
  'too many requests': 'errors.tooManyRequests',
  'too many login attempts, retry in 60s': 'errors.loginRateLimited',
  'invalid token': 'errors.invalidToken',
  'invalid totp': 'errors.invalidTotp',
  'agent not found': 'errors.agentNotFound',
  'not found': 'errors.notFound',
};

// 把请求异常转成可展示文案：优先按下发错误码本地化，其次退回服务端 message，最后用通用兜底。
export function apiErrorMessage(e: unknown, fallbackKey = 'common.error'): string {
  const err = e as (Error & { detail?: string }) | null;
  const key = err?.detail ? ERROR_CODE_KEYS[err.detail] : undefined;
  if (key) {
    const localized = t(key);
    if (localized !== key) return localized; // t() 未命中时会原样返回 key
  }
  return err?.message || t(fallbackKey);
}
