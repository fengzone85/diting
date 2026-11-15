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
  // S2/F9：登录失败次数过多触发指数封禁（服务端返回 login_blocked + retry_after 秒数）
  login_blocked: 'errors.loginBlocked',
  'too many totp failures': 'errors.totpFailures',
  // S2/F6：会话管理端点的参数/状态错误码
  'invalid session id': 'errors.invalidSessionId',
  'session not found': 'errors.sessionNotFound',
  // r4/P2-1：人用登录改造后的错误码（旧 'invalid token'/'invalid totp' 已不再下发，
  // 防枚举统一为 'invalid credentials'）。weak_password 走下方 reason 码映射（r5/P2-1）。
  'invalid credentials': 'errors.invalidCredentials',
  'invalid second factor': 'errors.invalidSecondFactor',
  'invalid current password': 'errors.invalidCurrentPassword',
  'ambiguous credentials': 'errors.ambiguousCredentials',
  'agent not found': 'errors.agentNotFound',
  'not found': 'errors.notFound',
  // S2/F5：节点白名单 Token 的两个作用域错误码，以及 Token 管理端点的参数校验码
  forbidden_scope: 'errors.forbiddenScope',
  forbidden_node: 'errors.forbiddenNode',
  invalid_scope: 'errors.invalidScope',
  unknown_agent_id: 'errors.unknownAgentId',
  invalid_expires_in_days: 'errors.invalidExpiresInDays',
  'name required': 'errors.nameRequired',
};

// r5/P2-1：weak_password 按服务端 reason 码本地化（message 中文仅兜底）。
export const WEAK_PASSWORD_REASON_KEYS: Record<string, string> = {
  too_short: 'errors.weakTooShort',
  too_long: 'errors.weakTooLong',
  numeric: 'errors.weakNumeric',
  low_variety: 'errors.weakLowVariety',
  sequence: 'errors.weakSequence',
  // 键名不得以 token 结尾（`xxx_token: '…'` 形态会被仓库卫生闸 H7 误判为凭据赋值）
  same_as_admin: 'errors.weakSameAsToken',
};

// 把请求异常转成可展示文案：优先按下发错误码本地化，其次退回服务端 message，最后用通用兜底。
export function apiErrorMessage(e: unknown, fallbackKey = 'common.error'): string {
  const err = e as (Error & { detail?: string; body?: { message?: unknown } }) | null;
  const key = err?.detail ? ERROR_CODE_KEYS[err.detail] : undefined;
  if (key) {
    const localized = t(key);
    if (localized !== key) return localized; // t() 未命中时会原样返回 key
  }
  // r5/P2-1：weak_password 按 reason 码本地化（服务端 message 是中文，英文界面不直出）。
  const body = err?.body as { message?: unknown; reason?: unknown } | undefined;
  if (err?.detail === 'weak_password' && typeof body?.reason === 'string') {
    const rk = WEAK_PASSWORD_REASON_KEYS[body.reason];
    if (rk) {
      const localizedReason = t(rk);
      if (localizedReason !== rk) return localizedReason;
    }
  }
  // r4/P2-1：未命中映射时优先服务端 body.message，再退 err.message（码串），最后通用兜底。
  const serverMsg = body?.message;
  if (typeof serverMsg === 'string' && serverMsg) return serverMsg;
  return err?.message || t(fallbackKey);
}
