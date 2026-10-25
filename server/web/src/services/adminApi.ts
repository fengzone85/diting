import { api } from './api';
import type { Agent, AgentArtifact, AgentDistributionResult, AgentVersionSummary, DeletedAgent, Settings, InstallCommands, ModifyCommands, Billing, AiConfig, AiStatus, AiReport, AiReportList, AiRunResult, AiNodeAnalysis, AiNodeReportItem, AiUsage, BackupState, BackupList, RestoreAuditReport, CapacityStatus, AlertRules, AlertOverride, AlertOverrideInput, NotifyChannel, NotifyGroup, WebhookConfig, ApiToken, ApiTokenCreated, DashboardLayoutItem, AdminSession } from './types';

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

  // 受控端自助注册令牌（SETUP_TOKEN，存库；明文只在生成/设置时回显一次）
  setupTokenStatus: () =>
    api.get<{ configured: boolean; source: 'db' | 'env-migrated' | 'cleared' | 'none'; weak: boolean }>('/api/admin/setup-token'),
  setupTokenRotate: (action: 'generate' | 'set' | 'clear', token?: string) =>
    api.post<{ ok: boolean; configured: boolean; token?: string }>('/api/admin/setup-token', { action, token }),

  // agents
  listAgents: () => api.get<Agent[]>('/api/agents'),
  getAgent: (id: string) => api.get<Agent>(`/api/agents/${encodeURIComponent(id)}`),
  createAgent: (payload: Partial<Agent>) => api.post<Agent & { token: string; install: InstallCommands }>('/api/agents', payload),
  updateAgent: (id: string, payload: Partial<Agent>) =>
    api.put<Agent>(`/api/agents/${encodeURIComponent(id)}`, payload),
  deleteAgent: (id: string) => api.del<void>(`/api/agents/${encodeURIComponent(id)}`),
  // F11：最近删除（7 天缓冲）
  listDeletedAgents: () =>
    api.get<{ items: DeletedAgent[]; grace_days: number }>('/api/agents/deleted'),
  restoreAgent: (id: string) =>
    api.post<{ ok: boolean }>(`/api/agents/${encodeURIComponent(id)}/restore`, {}),
  resetToken: (id: string) =>
    api.post<{ ok: boolean; token: string; install: InstallCommands }>(`/api/agents/${encodeURIComponent(id)}/reset-token`, {}),
  renewAgent: (id: string) =>
    api.post<{ ok: boolean; expire_at: string }>(`/api/agents/${encodeURIComponent(id)}/renew`, {}),
  getCommands: (id: string, probeTargets?: string) =>
    api.get<{ id: string; probe_targets: string; install: InstallCommands; modify: ModifyCommands }>(
      `/api/agents/${encodeURIComponent(id)}/commands${probeTargets ? `?probe_targets=${encodeURIComponent(probeTargets)}` : ''}`
    ),

  // V 阶段：受控端版本可判定性（期望版本对照 + 分布汇总）。
  // expected.version 为空 = 不做对照（所有节点状态都是 unknown）。
  getAgentVersions: () => api.get<AgentVersionSummary>('/api/admin/agent-versions'),
  setExpectedAgentVersion: (body: { version?: string; sha?: string }) =>
    api.put<{ ok: boolean; expected: { version: string; sha: string } }>('/api/admin/agent-versions/expected', body),
  setAgentBuildTag: (id: string, tag: string) =>
    api.put<{ ok: boolean; id: string; build_tag: string }>(
      `/api/admin/agents/${encodeURIComponent(id)}/build-tag`, { tag }
    ),

  // D 阶段：自定义受控端二进制 artifact + 一键批量分发。
  // 上传走原始 body（application/octet-stream），与后端 express.raw 解析一致；
  // 平台与备注走 query 参数（服务端没有 multipart 解析器）。
  listAgentArtifacts: () => api.get<{ list: AgentArtifact[] }>('/api/admin/agent-artifacts'),
  uploadAgentArtifact: (file: File, platform: string, sourceNote: string, onProgress?: (pct: number) => void) =>
    new Promise<{ ok: boolean; artifact_id: string; sha256: string; platform: string; size: number; uploaded_at: number; deduped: boolean }>((resolve, reject) => {
      const qs = new URLSearchParams({ platform, source_note: sourceNote || '' });
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/admin/agent-artifacts?${qs.toString()}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded * 100) / e.total));
      };
      xhr.onload = () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(xhr.responseText || '{}') as Record<string, unknown>; } catch { /* 非 JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as unknown as { ok: boolean; artifact_id: string; sha256: string; platform: string; size: number; uploaded_at: number; deduped: boolean });
        } else {
          const msg = typeof body.error === 'string' ? body.error : '';
          const err = new Error(msg || `${xhr.status}`);
          (err as Error & { status: number }).status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(file);
    }),
  deleteAgentArtifact: (id: string) =>
    api.del<{ ok: boolean; id: string }>(`/api/admin/agent-artifacts/${encodeURIComponent(id)}`),
  createAgentDistribution: (body: {
    agent_ids: string[];
    target: { os: string; arch: string };
    source: { kind: string; artifact_id?: string; release_url?: string; release_sha256?: string };
    expires_in_minutes?: number;
  }) => api.post<AgentDistributionResult>('/api/admin/agent-distribution', body),

  // S1/F1：告警规则覆盖（节点/分组）。NULL = 继承上层；DELETE = 整行回退。
  // 分组路径参数用 '-' 表示未分组默认组（空字符串无法作为路径段）。
  listAlertRules: () => api.get<AlertRules>('/api/admin/alert-rules'),
  setAgentAlertRule: (id: string, payload: AlertOverrideInput) =>
    api.put<{ ok: boolean; override: AlertOverride }>(
      `/api/admin/alert-rules/agent/${encodeURIComponent(id)}`, payload
    ),
  resetAgentAlertRule: (id: string) =>
    api.del<{ ok: boolean; id: string }>(`/api/admin/alert-rules/agent/${encodeURIComponent(id)}`),
  setGroupAlertRule: (grp: string, payload: AlertOverrideInput) =>
    api.put<{ ok: boolean; override: AlertOverride }>(
      `/api/admin/alert-rules/group/${encodeURIComponent(grp === '' ? '-' : grp)}`, payload
    ),
  resetGroupAlertRule: (grp: string) =>
    api.del<{ ok: boolean; grp: string }>(
      `/api/admin/alert-rules/group/${encodeURIComponent(grp === '' ? '-' : grp)}`
    ),

  // S1/F2：通知渠道 / 通知组
  listNotifyChannels: () => api.get<NotifyChannel[]>('/api/admin/notify/channels'),
  createNotifyChannel: (body: { type: string; name: string; enabled?: boolean; config?: Partial<WebhookConfig> }) =>
    api.post<NotifyChannel>('/api/admin/notify/channels', body),
  updateNotifyChannel: (id: number, body: { name?: string; enabled?: boolean; config?: Partial<WebhookConfig> }) =>
    api.put<NotifyChannel>(`/api/admin/notify/channels/${id}`, body),
  deleteNotifyChannel: (id: number) => api.del<{ ok: boolean; id: number }>(`/api/admin/notify/channels/${id}`),
  testNotifyChannel: (id: number) => api.post<{ ok: boolean }>(`/api/admin/notify/channels/${id}/test`, {}),
  listNotifyGroups: () => api.get<NotifyGroup[]>('/api/admin/notify/groups'),
  createNotifyGroup: (body: { name: string; events: string[]; channel_ids: number[]; enabled?: boolean }) =>
    api.post<NotifyGroup>('/api/admin/notify/groups', body),
  updateNotifyGroup: (id: number, body: { name?: string; events?: string[]; channel_ids?: number[]; enabled?: boolean }) =>
    api.put<NotifyGroup>(`/api/admin/notify/groups/${id}`, body),
  deleteNotifyGroup: (id: number) => api.del<{ ok: boolean; id: number }>(`/api/admin/notify/groups/${id}`),
  listNotifyEvents: () => api.get<{ events: string[] }>('/api/admin/notify/events'),
  // S2/F2：旧 notify_config 是否已被默认通知组接管（用于后台迁移提示横幅）
  notifyMigrationStatus: () => api.get<{
    legacy_config_present: boolean;
    default_group_present: boolean;
    banner: boolean;
    groups_enabled: boolean;
  }>('/api/admin/notify/migration-status'),
  listThemes: () => api.get<{ id: string; name: string; author?: string; description?: string }[]>('/api/public/themes'),

  // S5/F10：主题市场。读接口 readonly Token 也可用，写接口需 admin。
  listInstalledThemes: () => api.get<ThemeInfo[]>('/api/admin/theme/list'),
  listThemeSources: () => api.get<ThemeSource[]>('/api/admin/theme/market/sources'),
  createThemeSource: (body: { name: string; url: string; enabled?: boolean }) =>
    api.post<ThemeSource>('/api/admin/theme/market/sources', body),
  updateThemeSource: (id: string, body: { name?: string; url?: string; enabled?: boolean }) =>
    api.put<ThemeSource>(`/api/admin/theme/market/sources/${encodeURIComponent(id)}`, body),
  deleteThemeSource: (id: string) =>
    api.del<{ deleted: boolean }>(`/api/admin/theme/market/sources/${encodeURIComponent(id)}`),
  themeCatalog: (refresh = false) =>
    api.get<ThemeCatalog>(`/api/admin/theme/market/catalog${refresh ? '?refresh=true' : ''}`),
  installTheme: (source_id: string, short: string) =>
    api.post<{ manifest: ThemeInfo }>('/api/admin/theme/market/install', { source_id, short }),
  importTheme: (url: string, preview = false) =>
    api.post<{ manifest: ThemeInfo; exists?: boolean }>(
      `/api/admin/theme/import${preview ? '?preview=true' : ''}`, { url }
    ),
  updateTheme: (short: string, body: { url?: string; git_owner?: string; git_repo?: string } = {}) =>
    api.post<{ manifest: ThemeInfo }>('/api/admin/theme/update', { short, ...body }),
  rollbackTheme: (short: string, backup: string) =>
    api.post<{ manifest: ThemeInfo }>('/api/admin/theme/rollback', { short, backup }),
  listThemeBackups: (short: string) =>
    api.get<ThemeBackup[]>(`/api/admin/theme/backups?short=${encodeURIComponent(short)}`),
  setTheme: (theme: string) => api.post<{ enabled: string }>('/api/admin/theme/set', { theme }),
  deleteTheme: (short: string) =>
    api.post<{ deleted: boolean; fallbackTheme: string | null }>('/api/admin/theme/delete', { short }),
  getThemeConfig: (theme: string) =>
    api.get<{ theme: string; configuration: ThemeConfiguration; values: Record<string, unknown> }>(
      `/api/admin/theme/config?theme=${encodeURIComponent(theme)}`
    ),
  saveThemeConfig: (theme: string, values: Record<string, unknown>) =>
    api.post<{ saved: boolean; values: Record<string, unknown> }>(
      `/api/admin/theme/config?theme=${encodeURIComponent(theme)}`, values
    ),

  // S2/F5：API Token 管理。明文只在创建响应里返回一次（ApiTokenCreated.token），
  // 列表接口不含明文与哈希，故「丢失即吊销重建」。
  listApiTokens: () => api.get<{ list: ApiToken[] }>('/api/admin/api-tokens'),
  createApiToken: (body: {
    name: string;
    scope?: 'readonly' | 'admin';
    agent_ids?: string[];
    expires_in_days?: number;
  }) => api.post<ApiTokenCreated>('/api/admin/api-tokens', body),
  revokeApiToken: (id: string) =>
    api.del<{ ok: boolean; id: string }>(`/api/admin/api-tokens/${encodeURIComponent(id)}`),

  // S2/F6：登录会话管理。列表含来源 IP 与 UA，属跨设备敏感信息（后端限定全局作用域管理员）。
  listSessions: () => api.get<{ list: AdminSession[] }>('/api/admin/sessions'),
  revokeSession: (id: string) =>
    api.del<{ ok: boolean }>(`/api/admin/sessions/${encodeURIComponent(id)}`),
  // keepCurrent=true：踢掉其它设备但保留当前会话；false：全局吊销（含当前会话）。
  revokeAllSessions: (keepCurrent = true) =>
    api.post<{ ok: boolean; revoked: number; kept_current: boolean }>(
      '/api/admin/sessions/revoke-all', { keep_current: keepCurrent }),

  // diagnostics
  clientIp: () => api.get<{ ip: string; trust_proxy: string | number | string[]; x_forwarded_for: string }>('/api/client-ip'),

  // overview / settings
  overview: () => api.get<Record<string, unknown>>('/api/overview'),
  getSettings: () => api.get<Settings>('/api/settings'),
  saveSettings: (payload: Settings) => api.put<Settings>('/api/settings', payload),
  // 后台仪表盘布局（只写 ui.admin_dashboard_layout，不影响其他设置）
  saveDashboardLayout: (layout: DashboardLayoutItem[]) =>
    api.put<{ ok: boolean; layout: DashboardLayoutItem[] }>('/api/admin/dashboard/layout', { layout }),

  // 数据库备份监控（宿主侧 diting.sh 回写状态，服务端只做展示与策略下发）
  getBackupStatus: () => api.get<{ config: Record<string, unknown>; state: BackupState }>('/api/admin/backup-status'),

  // F12：容量保险丝状态与一键清理（清理 = 按当前保留天数删过期明细）
  getCapacity: () => api.get<CapacityStatus>('/api/admin/capacity'),
  cleanupCapacity: () => api.post<CapacityStatus>('/api/admin/capacity/cleanup'),

  // F8.6：最近一次恢复审查（后台顶部黄条用，避免拉整个备份目录）
  getRestoreAudit: () => api.get<{ report: RestoreAuditReport | null }>('/api/admin/restore-audit'),

  // F8.1：应用内一致性快照（不用停服，产物与宿主脚本同名规则）
  createBackup: () =>
    api.post<{ ok: boolean; name: string; size_bytes: number; mtime: number }>('/api/admin/backups'),

  // 备份文件管理（需要宿主备份目录已挂进容器）
  listBackups: () => api.get<BackupList>('/api/admin/backups'),
  deleteBackup: (name: string) => api.del<{ ok: boolean }>(`/api/admin/backups/${encodeURIComponent(name)}`),
  requestRestore: (name: string) =>
    api.post<{ ok: boolean; queued: boolean }>(`/api/admin/backups/${encodeURIComponent(name)}/restore`, {}),
  // 下载走同源 GET，直接用 <a download> 触发，避免把整份备份读进内存
  backupDownloadUrl: (name: string) => `/api/admin/backups/${encodeURIComponent(name)}/download`,
  // 上传外部备份：api 封装固定 JSON + 解析 JSON，二进制上传单独走 XHR（还能拿进度）
  uploadBackup: (file: File, onProgress?: (pct: number) => void) =>
    new Promise<{ ok: boolean; name: string; size_bytes: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/admin/backups/upload');
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(xhr.responseText || '{}') as Record<string, unknown>; } catch { /* 非 JSON（网关错误页） */ }
        const msg = typeof body.message === 'string' ? body.message : (typeof body.error === 'string' ? body.error : '');
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as unknown as { ok: boolean; name: string; size_bytes: number });
        } else {
          reject(new Error(msg || `${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(file);
    }),

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
  // 单节点按需分析（服务端按「节点+窗口」缓存 30 分钟，重复点击不会重复计费）
  // hours：24（默认）/ 168（7 天）/ 720（30 天）
  aiAnalyzeNode: (id: string, hours = 24) =>
    api.post<AiNodeAnalysis>(`/api/ai/analyze-node/${encodeURIComponent(id)}?hours=${encodeURIComponent(String(hours))}`, {}),
  // 单节点分析历史（§8 T17）：列表不含 report_json，仅渲染所需字段
  aiNodeReports: (id: string, limit = 10) =>
    api.get<{ agent_id: string; limit: number; list: AiNodeReportItem[] }>(
      `/api/ai/node-reports?agent_id=${encodeURIComponent(id)}&limit=${limit}`
    ),

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

// ---- S5/F10 主题市场 -------------------------------------------------------
export interface ThemeConfigField {
  key: string;
  name: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'color';
  options: string[];
  default: unknown;
  required: boolean;
  help: string;
}
export interface ThemeConfiguration {
  type: 'managed';
  fields: ThemeConfigField[];
}
export interface ThemeInfo {
  short: string;
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  url: string;
  preview: string;
  configuration: ThemeConfiguration | null;
  diting: { compatibility: string; needsRelaxedCsp: boolean };
  installed_at: number;
  enabled: boolean;
  configurable: boolean;
  bundled: boolean;
  manifest_file?: string;
  legacy?: boolean;
}
export interface ThemeSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}
export interface ThemeCatalogEntry {
  short: string;
  name: string;
  description: string;
  version: string;
  author: string;
  url: string;
  preview: string;
  download: string;
  sha256: string;
  installable: boolean;
  source_id: string;
  source_name: string;
}
export interface ThemeCatalog {
  themes: ThemeCatalogEntry[];
  sources: { id: string; name: string; count: number; error: string | null }[];
}
export interface ThemeBackup {
  name: string;
  created_at: number;
  size: number;
}
