import { api } from './api';
import type { Agent, Settings, User, Alert, InstallCommands, ModifyCommands } from './types';

export interface AuthStatus {
  logged_in: boolean;
  role?: 'admin' | 'readonly';
  twofa_required?: boolean;
}

export const adminApi = {
  // auth / 2fa
  status: () => api.get<{ enabled: boolean }>('/api/admin/2fa/status'),
  twoFAStatus: () => api.get<{ enabled: boolean }>('/api/admin/2fa/status'),
  login: (token: string, totp?: string) =>
    api.post<{ ok: boolean; totp: boolean }>('/api/login', { token, totp }),
  logout: () => api.post<void>('/api/logout'),
  setup2FA: () =>
    api.post<{ secret: string; otpauth_uri: string; enabled: boolean }>('/api/admin/2fa/setup', {}),
  enable2FA: (code: string) =>
    api.post<{ ok: boolean; enabled: boolean }>('/api/admin/2fa/enable', { code }),
  disable2FA: (code: string) =>
    api.post<{ ok: boolean; enabled: boolean }>('/api/admin/2fa/disable', { code }),

  // setup
  register: (setupToken: string, username: string, password: string) =>
    api.post<void>('/api/setup/register', { setup_token: setupToken, username, password }),
  generateAgent: (name: string) =>
    api.post<{ id: string; token: string }>('/api/setup/generate', { name }),

  // agents
  listAgents: () => api.get<Agent[]>('/api/agents'),
  getAgent: (id: string) => api.get<Agent>(`/api/agents/${encodeURIComponent(id)}`),
  createAgent: (payload: Partial<Agent>) => api.post<Agent & { token: string; install: InstallCommands }>('/api/agents', payload),
  updateAgent: (id: string, payload: Partial<Agent>) =>
    api.put<Agent>(`/api/agents/${encodeURIComponent(id)}`, payload),
  deleteAgent: (id: string) => api.del<void>(`/api/agents/${encodeURIComponent(id)}`),
  resetToken: (id: string) =>
    api.post<{ ok: boolean; token: string; install: InstallCommands }>(`/api/agents/${encodeURIComponent(id)}/reset-token`, {}),
  renewAgent: (id: string) =>
    api.post<{ ok: boolean; expire_at: string }>(`/api/agents/${encodeURIComponent(id)}/renew`, {}),
  getCommands: (id: string, probeTargets?: string) =>
    api.get<{ id: string; probe_targets: string; install: InstallCommands; modify: ModifyCommands }>(
      `/api/agents/${encodeURIComponent(id)}/commands${probeTargets ? `?probe_targets=${encodeURIComponent(probeTargets)}` : ''}`
    ),
  listThemes: () => api.get<{ id: string; name: string; author?: string; description?: string }[]>('/api/public/themes'),

  // overview / settings
  overview: () => api.get<Record<string, unknown>>('/api/overview'),
  getSettings: () => api.get<Settings>('/api/settings'),
  saveSettings: (payload: Settings) => api.put<Settings>('/api/settings', payload),

  // alerts
  listAlerts: () => api.get<Alert[]>('/api/alerts'),
  createAlert: (payload: Partial<Alert>) => api.post<Alert>('/api/alerts', payload),
  deleteAlert: (id: string) => api.del<void>(`/api/alerts/${encodeURIComponent(id)}`),

  // users
  listUsers: () => api.get<User[]>('/api/admin/users'),
  createUser: (payload: Partial<User> & { password: string }) =>
    api.post<User>('/api/admin/users', payload),
  deleteUser: (id: string) => api.del<void>(`/api/admin/users/${encodeURIComponent(id)}`),

  // billing
  billingStatus: () => api.get<{ enabled: boolean }>('/api/billing/status'),
};
