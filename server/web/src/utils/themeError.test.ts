// @vitest-environment jsdom
// themeErrorMessage 映射单测（回归护栏）：
//   1. 服务端返回的裸错误码（来源列表的 s.error）与 Error.detail 都要能翻译；
//   2. 每个映射目标键都必须在 zh-CN / en-US 两份词典里存在；
//   3. 未收录的码要保留原码，便于排查，而不是静默变成「操作失败」。
import { describe, it, expect, beforeAll } from 'vitest';
import { THEME_ERROR_CODE_KEYS, themeErrorMessage } from './themeError';
import { setLocale, t } from '../composables/useI18n';
import { zhCN } from './i18n/zh-CN';
import { enUS } from './i18n/en-US';

function err(detail: string, status = 400) {
  return Object.assign(new Error(`${detail} (HTTP ${status})`), { status, detail });
}

beforeAll(() => setLocale('zh-CN'));

describe('themeErrorMessage 错误码映射', () => {
  it('裸错误码（来源卡片 s.error）→ 本地化提示', () => {
    expect(themeErrorMessage('insecure_scheme')).toBe(t('theme.err.insecureScheme'));
  });

  it('Error.detail 优先于 message，并剥掉 (HTTP nnn) 后缀', () => {
    expect(themeErrorMessage(err('http_404'))).toBe(t('theme.err.notFound'));
  });

  it('未单列的 http_<状态码> → 通用 HTTP 提示', () => {
    expect(themeErrorMessage('http_410')).toBe(t('theme.err.http', { status: '410' }));
  });

  it('未知错误码 → 带原码兜底，便于排查', () => {
    const msg = themeErrorMessage('some_new_code');
    expect(msg).toContain('some_new_code');
  });

  it('非错误码文本（网关错误页）→ 原样展示', () => {
    expect(themeErrorMessage('502 Bad Gateway')).toBe('502 Bad Gateway');
  });

  it('空输入 → 通用兜底', () => {
    expect(themeErrorMessage('')).toBe(t('theme.actionFailed'));
    expect(themeErrorMessage(undefined)).toBe(t('theme.actionFailed'));
  });
});

describe('映射键与词典一致性', () => {
  it('每个 i18n 目标键在中英词典中都存在', () => {
    for (const [code, key] of Object.entries(THEME_ERROR_CODE_KEYS)) {
      expect(zhCN[key], `zh-CN 缺 ${key}（错误码 ${code}）`).toBeTruthy();
      expect(enUS[key], `en-US 缺 ${key}（错误码 ${code}）`).toBeTruthy();
    }
  });

  it('词典中的键都能被 t() 取到（未命中会原样返回 key）', () => {
    for (const key of new Set(Object.values(THEME_ERROR_CODE_KEYS))) {
      expect(t(key)).not.toBe(key);
    }
  });
});
