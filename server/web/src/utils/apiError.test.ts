// @vitest-environment jsdom
// apiError 映射单测（回归护栏）：
//   1. 映射键必须与服务端返回的原始 error 字符串逐字一致——历史上 `admin required`
//      被误写成 `admin_required`（下划线），导致 403 永远拿不到本地化文案；
//   2. 每个映射目标键都必须在 zh-CN / en-US 两份词典里存在，避免「引用了不存在的键」。
import { describe, it, expect, beforeAll } from 'vitest';
import { ERROR_CODE_KEYS, apiErrorMessage } from './apiError';
import { setLocale, t } from '../composables/useI18n';
import { zhCN } from './i18n/zh-CN';
import { enUS } from './i18n/en-US';

function err(detail: string, status = 403) {
  return Object.assign(new Error(`${detail} (HTTP ${status})`), { status, detail });
}

beforeAll(() => setLocale('zh-CN'));

describe('apiErrorMessage 错误码映射', () => {
  it('maps "admin required"（含空格）——回归：下划线写法永不命中', () => {
    expect(apiErrorMessage(err('admin required'))).toBe(t('errors.adminRequired'));
  });

  it('maps "totp required"（2FA 已启用但未验证）', () => {
    expect(apiErrorMessage(err('totp required', 401))).toBe(t('errors.totpRequired'));
  });

  it('maps "ip not allowed"（白名单先于 401 拦下匿名请求）', () => {
    expect(apiErrorMessage(err('ip not allowed'))).toBe(t('errors.ipNotAllowed'));
  });

  it('maps "unauthorized"', () => {
    expect(apiErrorMessage(err('unauthorized', 401))).toBe(t('errors.unauthorized'));
  });

  it('未收录的错误码回落到服务端 message', () => {
    const e = Object.assign(new Error('AI 分析未启用，请先在配置中开启 (HTTP 400)'), {
      status: 400,
      detail: 'some_unknown_code',
    });
    expect(apiErrorMessage(e)).toContain('AI 分析未启用');
  });
});

describe('映射键与词典一致性', () => {
  it('每个 i18n 目标键在中英词典中都存在', () => {
    for (const [code, key] of Object.entries(ERROR_CODE_KEYS)) {
      expect(zhCN[key], `zh-CN 缺 ${key}（错误码 ${code}）`).toBeTruthy();
      expect(enUS[key], `en-US 缺 ${key}（错误码 ${code}）`).toBeTruthy();
    }
  });

  it('词典中的键都能被 t() 取到（未命中会原样返回 key）', () => {
    for (const key of Object.values(ERROR_CODE_KEYS)) {
      expect(t(key)).not.toBe(key);
    }
  });
});
