import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from './api';
import { getInstallStatus, completeInstall } from './install';

describe('安装向导服务', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getInstallStatus 走 GET /api/install/status', async () => {
    const payload = { state: 'ready' as const, required: true, port: 18081 };
    (api.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(payload);

    await expect(getInstallStatus()).resolves.toEqual(payload);
    expect(api.get).toHaveBeenCalledWith('/api/install/status');
  });

  it('completeInstall 走 POST /api/install/complete 并原样透传表单', async () => {
    const payload = {
      sitename: '面板',
      description: '说明',
      site_url: 'https://pt.example.com',
      agent_server_url: 'https://pt.example.com:8443',
      token_mode: 'generate' as const,
    };
    (api.post as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'success', token: 'adm_x', warnings: [] });

    const res = await completeInstall(payload);
    expect(api.post).toHaveBeenCalledWith('/api/install/complete', payload);
    expect(res.warnings).toEqual([]);
  });
});
