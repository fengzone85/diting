import { api } from './api';
import type { Agent, Settings, User, Alert } from './types';

export interface AuthStatus {
  logged_in: boolean;
  role?: 'admin' | 'readonly';
  twofa_required?: boolean;
}

export const adminApi = {
  // auth
  status: () => api.get<{ enabled: boolean }>('/api/admin/2fa/status'),
  login: (token: string, totp?: string) =>
    api.post<{ ok: boolean; totp: boolean }>('/api/login', { token, totp }),
  logout: () => api.post<void>('/api/logout'),
  totpQr: () => api.get<{ qr: string; secret: string }>('/api/admin/2fa/qr'),
  setupTotp: (secret: string, token: string) =>
    api.post<AuthStatus>('/api/admin/2fa/setup', { secret, token }),
  verifyTotp: (token: string) =>
    api.post<AuthStatus>('/api/admin/2fa/verify', { token }),

  // setup
  register: (setupToken: string, username: string, password: string) =>
    api.post<void>('/api/setup/register', { setup_token: setupToken, username, password }),
  generateAgent: (name: string) =>
    api.post<{ id: string; token: string }>('/api/setup/generate', { name }),

  // agents
  listAgents: () => api.get<Agent[]>('/api/agents'),
  getAgent: (id: string) => api.get<Agent>(`/api/agents/${encodeURIComponent(id)}`),
  createAgent: (payload: Partial<Agent>) => api.post<Agent>('/api/agents', payload),
  updateAgent: (id: string, payload: Partial<Agent>) =>
    api.put<Agent>(`/api/agents/${encodeURIComponent(id)}`, payload),
  deleteAgent: (id: string) => api.del<void>(`/api/agents/${encodeURIComponent(id)}`),

  // overview / settings
  overview: () => api.get<Record<string, unknown>>('/api/overview'),
  getSettings: () => api.get<Settings>('/api/settings'),
  saveSettings: (payload: Settings) => api.post<Settings>('/api/settings', payload),

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
