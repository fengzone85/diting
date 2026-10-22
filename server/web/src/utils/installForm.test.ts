import { describe, it, expect } from 'vitest';
import {
  MIN_TOKEN_LEN, URL_MAX,
  parseUrl, isAcceptableUrl, agentUrlWarning, checkCustomToken, warnI18nKey,
} from './installForm';

describe('parseUrl', () => {
  it('接受合法 URL 并去掉首尾空格', () => {
    expect(parseUrl('  https://a.example.com  ')?.hostname).toBe('a.example.com');
  });
  it('非法输入返回 null', () => {
    expect(parseUrl('not a url')).toBeNull();
    expect(parseUrl('')).toBeNull();
    expect(parseUrl(undefined as unknown as string)).toBeNull();
  });
});

describe('isAcceptableUrl', () => {
  it('选填字段允许空值，必填字段不允许', () => {
    expect(isAcceptableUrl('', false)).toBe(true);
    expect(isAcceptableUrl('   ', false)).toBe(true);
    expect(isAcceptableUrl('', true)).toBe(false);
  });

  it('只接受 http / https', () => {
    expect(isAcceptableUrl('http://a.example.com', true)).toBe(true);
    expect(isAcceptableUrl('https://a.example.com', true)).toBe(true);
    expect(isAcceptableUrl('ftp://a.example.com', true)).toBe(false);
    expect(isAcceptableUrl('javascript:alert(1)', true)).toBe(false);
  });

  it('拒绝带 userinfo 的地址', () => {
    expect(isAcceptableUrl('https://user:pass@a.example.com', true)).toBe(false);
  });

  it('长度上限', () => {
    const long = `https://a.example.com/${'x'.repeat(URL_MAX)}`;
    expect(isAcceptableUrl(long, true)).toBe(false);
  });
});

describe('agentUrlWarning', () => {
  it('回环/内网地址给出软告警', () => {
    for (const u of [
      'https://localhost:8443',
      'https://127.0.0.1',
      'https://10.1.2.3',
      'https://192.168.1.10',
      'https://172.17.0.1',
    ]) {
      expect(agentUrlWarning(u, null)).toBe('install.warnPrivate');
    }
  });

  it('显式端口与监听端口不一致时提示反代 upstream', () => {
    expect(agentUrlWarning('https://pt.example.com:8443', 18081)).toBe('install.warnPortMismatch');
    expect(agentUrlWarning('https://pt.example.com:18081', 18081)).toBe('');
  });

  it('无端口 / 无监听端口 / 非法地址时不告警', () => {
    expect(agentUrlWarning('https://pt.example.com', 18081)).toBe('');
    expect(agentUrlWarning('https://pt.example.com:8443', null)).toBe('');
    expect(agentUrlWarning('bad url', 18081)).toBe('');
  });

  it('回环优先于端口不一致（更严重的先报）', () => {
    expect(agentUrlWarning('https://127.0.0.1:9000', 18081)).toBe('install.warnPrivate');
  });
});

describe('checkCustomToken', () => {
  it('空 / 占位符 / 过短', () => {
    expect(checkCustomToken('')).toEqual({ ok: false, key: 'install.tokenEmpty' });
    expect(checkCustomToken('   ')).toEqual({ ok: false, key: 'install.tokenEmpty' });
    expect(checkCustomToken('change-me-admin-token')).toEqual({ ok: false, key: 'install.tokenPlaceholder' });
    expect(checkCustomToken('short')).toEqual({ ok: false, key: 'install.tokenTooShort' });
    expect(checkCustomToken('a'.repeat(MIN_TOKEN_LEN - 1))).toEqual({ ok: false, key: 'install.tokenTooShort' });
  });

  it('纯数字 / 字符种类过少', () => {
    expect(checkCustomToken('1234567890123456')).toEqual({ ok: false, key: 'install.tokenWeak' });
    expect(checkCustomToken('aaaaaaaaaaaaaaaaaaaa')).toEqual({ ok: false, key: 'install.tokenWeak' });
  });

  it('含连续序列', () => {
    expect(checkCustomToken('passwordpasswordabcd1234')).toEqual({ ok: false, key: 'install.tokenSeq' });
    expect(checkCustomToken('zx9QWERTYuiop2345asdf')).toEqual({ ok: false, key: 'install.tokenSeq' });
  });

  it('强 Token 通过', () => {
    expect(checkCustomToken('diting-e2e-token-9f8e7d6c5b')).toEqual({ ok: true, key: 'install.tokenOk' });
  });
});

describe('warnI18nKey', () => {
  it('已知告警码映射到文案键', () => {
    expect(warnI18nKey('agent_server_url_private')).toBe('install.warnPrivate');
    expect(warnI18nKey('agent_server_url_port_mismatch')).toBe('install.warnPortMismatch');
  });
  it('未知码返回空串（不渲染）', () => {
    expect(warnI18nKey('whatever')).toBe('');
  });
});
