import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from './api';
import { getAuthStatus, logout } from './auth';

const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

describe('auth 服务', () => {
  beforeEach(() => vi.clearAllMocks());

  it('能访问 2fa/status 即视为已登录（admin）', async () => {
    get.mockResolvedValue({ enabled: false });
    await expect(getAuthStatus()).resolves.toEqual({ logged_in: true, role: 'admin' });
    expect(get).toHaveBeenCalledWith('/api/admin/2fa/status');
  });

  it('401 / 403 视为未登录', async () => {
    for (const status of [401, 403]) {
      get.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status }));
      await expect(getAuthStatus()).resolves.toEqual({ logged_in: false });
    }
  });

  it('其它错误继续抛出（不吞掉 5xx）', async () => {
    get.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(getAuthStatus()).rejects.toThrow('boom');
  });

  it('logout 调 POST /api/logout', async () => {
    post.mockResolvedValue(undefined);
    await logout();
    expect(post).toHaveBeenCalledWith('/api/logout');
  });
});
