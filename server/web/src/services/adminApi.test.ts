// adminApi 的 API Token 端点封装单测（回归护栏）：
//   路径 / HTTP 方法 / 请求体形状一旦改动，前端与后端（/admin/api-tokens）就会悄悄错位，
//   这类错误在类型层面看不出来，只能靠断言 fetch 的入参锁住。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { adminApi } from './adminApi';

interface Captured {
  url: string;
  init: RequestInit;
}

function mockFetch(body: unknown, status = 200) {
  const captured: Captured[] = [];
  global.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    captured.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return captured;
}

describe('adminApi API Token endpoints', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('listApiTokens: GET /api/admin/api-tokens', async () => {
    const captured = mockFetch({ list: [] });
    const res = await adminApi.listApiTokens();
    expect(res.list).toEqual([]);
    expect(captured[0].url).toBe('/api/admin/api-tokens');
    expect(captured[0].init.method).toBe('GET');
  });

  it('createApiToken: POST 携带 name/scope/agent_ids/expires_in_days', async () => {
    const captured = mockFetch({ id: 'tok_1', token: 'diting_x', notice: 'once' });
    const res = await adminApi.createApiToken({
      name: 'panel',
      scope: 'readonly',
      agent_ids: ['agt_a'],
      expires_in_days: 90,
    });
    expect(res.token).toBe('diting_x');
    expect(captured[0].url).toBe('/api/admin/api-tokens');
    expect(captured[0].init.method).toBe('POST');
    expect(JSON.parse(String(captured[0].init.body))).toEqual({
      name: 'panel',
      scope: 'readonly',
      agent_ids: ['agt_a'],
      expires_in_days: 90,
    });
  });

  it('revokeApiToken: DELETE 且 id 经过 encodeURIComponent', async () => {
    const captured = mockFetch({ ok: true, id: 'tok_a/b' });
    await adminApi.revokeApiToken('tok_a/b');
    expect(captured[0].url).toBe('/api/admin/api-tokens/tok_a%2Fb');
    expect(captured[0].init.method).toBe('DELETE');
  });

  it('错误码透传到 Error.detail（供 apiErrorMessage 本地化）', async () => {
    mockFetch({ error: 'forbidden_scope' }, 403);
    await expect(adminApi.listApiTokens()).rejects.toMatchObject({ detail: 'forbidden_scope', status: 403 });
  });
});
