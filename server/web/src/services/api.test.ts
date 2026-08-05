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
    } as Response);

    await expect(api.get('/api/test')).rejects.toThrow('500 Internal Server Error');
  });
});
