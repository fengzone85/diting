import { api } from './api';
import type { Agent, Settings, InstallCommands, ModifyCommands, Billing, AiConfig, AiStatus, AiReport, AiReportList, AiRunResult, AiNodeAnalysis, AiUsage, BackupState } from './types';

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

  // diagnostics
  clientIp: () => api.get<{ ip: string; trust_proxy: string | number | string[]; x_forwarded_for: string }>('/api/client-ip'),

  // overview / settings
  overview: () => api.get<Record<string, unknown>>('/api/overview'),
  getSettings: () => api.get<Settings>('/api/settings'),
  saveSettings: (payload: Settings) => api.put<Settings>('/api/settings', payload),

  // 数据库备份监控（宿主侧 diting.sh 回写状态，服务端只做展示与策略下发）
  getBackupStatus: () => api.get<{ config: Record<string, unknown>; state: BackupState }>('/api/admin/backup-status'),

  // alerts
  testAlert: () => api.post<{ ok: boolean; message?: string }>('/api/test-alert', {}),

  // billing
  billingOverview: () => api.get<Billing>('/api/billing'),

  // AI 运维分析
  aiConfig: () => api.get<{ config: AiConfig }>('/api/ai/config'),
  saveAiConfig: (config: Partial<AiConfig>) => api.put<{ ok: boolean }>('/api/ai/config', { config }),
  aiStatus: () => api.get<AiStatus>('/api/ai/status'),
  // AI 手动触发为【异步任务】：202=已受理（随后用 aiStatus() 轮询 running/last_status）；
  // force=true 绕过冷却（用于连续重跑或调试）。
  runAi: (opts?: { force?: boolean }) =>
    api.post<AiRunResult>(`/api/ai/run${opts?.force ? '?force=1' : ''}`, {}),
  aiReports: (limit = 20, offset = 0) =>
    api.get<AiReportList>(`/api/ai/reports?limit=${limit}&offset=${offset}`),
  aiReport: (id: number) => api.get<AiReport>(`/api/ai/reports/${encodeURIComponent(String(id))}`),
  // AI 用量趋势（按 UTC 日聚合 token 消耗）
  aiUsage: (days = 7) => api.get<AiUsage>(`/api/ai/usage?days=${days}`),
  // 单节点按需分析（服务端缓存 30 分钟，重复点击不会重复计费）
  aiAnalyzeNode: (id: string) => api.post<AiNodeAnalysis>(`/api/ai/analyze-node/${encodeURIComponent(id)}`, {}),

  // 批量时序（所有受控端），避免前端 N+1
  sparklines: (range: '1h' | '6h' | '24h' | '7d' | '30d' = '6h') =>
    api.get<Record<string, MetricRow[]>>(`/api/agents/sparklines?range=${range}`),
  // 集群平均 CPU/内存趋势（仪表盘专用）：后端 SQL 层按时间桶聚合，只返回最终曲线，避免前端拉全量卡顿。
  clusterTrend: (range: '1h' | '6h' | '24h' | '7d' | '30d' = '6h') =>
    api.get<{ ts: number; cpu: number | null; mem_pct: number | null }[]>(`/api/agents/sparklines/overview?range=${range}`),
  // 单受控端时序
  metrics: (id: string, range: '1h' | '6h' | '24h' | '7d' | '30d' = '6h') =>
    api.get<MetricRow[]>(`/api/agents/${encodeURIComponent(id)}/metrics?range=${range}`),

  // 审计日志
  auditLogs: (limit = 100, offset = 0) =>
    api.get<AuditLogList>(`/api/admin/audit-logs?limit=${limit}&offset=${offset}`),
};

export interface MetricRow {
  ts: number;
  cpu?: number;
  mem_pct?: number;
  net_rx_rate?: number;
  net_tx_rate?: number;
  net_rx_month?: number;
  net_tx_month?: number;
  load1?: number;
  [k: string]: unknown;
}

export interface AuditLogEntry {
  id: number;
  ts: number;
  admin: string;
  ip: string;
  action: string;
  detail: string;
  via: string;
}
export interface AuditLogList {
  logs: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
}
