import { t } from '../composables/useI18n';

// 后端 error 码 → 本地化文案键的映射。
//
// 背景：服务端 API 统一返回 { error: '<code>', message?: '<中文兜底>' }，
// services/api.ts 已把 error 字段挂到 Error.detail 上（详见该文件 request()）。
// 这里做的是「机器可读码 → 本地化文案」的最后一步，避免把服务端原文直接甩给用户、
// 也避免各视图重复写死同一批判断。
const ERROR_CODE_KEYS: Record<string, string> = {
  server_url_not_configured: 'errors.serverUrlNotConfigured',
  https_required: 'errors.httpsRequired',
  already_initialized: 'errors.alreadyInitialized',
  unauthorized: 'errors.unauthorized',
  admin_required: 'errors.adminRequired',
  'ip not allowed': 'errors.ipNotAllowed',
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
