import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

describe('api wrapper', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('get returns parsed json', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
    } as Response);

    const res = await api.get<{ ok: boolean }>('/api/test');
    expect(res).toEqual({ ok: true });
  });

  it('post sends json body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ id: 1 }),
      text: async () => '{"id":1}',
    } as Response);

    await api.post('/api/test', { name: 'x' });
    expect(fetch).toHaveBeenCalledWith('/api/test', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'x' }),
      credentials: 'same-origin',
    }));
  });

  it('throws on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
      text: async () => '{}',
    } as Response);

    await expect(api.get('/api/test')).rejects.toThrow('500 Internal Server Error');
  });

  // 无 error/message 字段时不应破坏原有 message 形态（含 HTTP 状态码后缀）
  it('prefers server error message over http text', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ error: 'invalid totp', need_totp: true }),
    } as Response);

    await expect(api.post('/api/login', {})).rejects.toThrow('invalid totp (HTTP 401)');
  });

  // 服务端用 message 字段返回可读文案时同样要透传
  it('falls back to message field', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ message: '请先在设置中填写 Agent 连接地址' }),
    } as Response);

    await expect(api.get('/api/test')).rejects.toThrow('请先在设置中填写 Agent 连接地址');
  });

  // 网关错误页是 HTML：必须静默降级为 HTTP 文本，而不是抛出解析异常
  it('falls back to http text on html gateway error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => '<html><head><title>502 Bad Gateway</title></head></html>',
    } as Response);

    await expect(api.get('/api/test')).rejects.toThrow('502 Bad Gateway');
  });

  // err.status / err.detail 被多处逻辑依赖，透传改造不得丢失
  it('keeps status and exposes detail', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'server_url_not_configured' }),
    } as Response);

    try {
      await api.get('/api/test');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as Error & { status: number; detail: string };
      expect(err.status).toBe(400);
      expect(err.detail).toBe('server_url_not_configured');
    }
  });
});
