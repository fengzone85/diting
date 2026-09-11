export interface Agent {
  id: string;
  name: string;
  country?: string;
  country_code?: string;
  group?: string;
  grp?: string;
  online?: boolean;
  cpu?: number;
  cpu_percent?: number;
  mem_pct?: number;
  mem_used?: number;
  mem_total?: number;
  disk_pct?: number;
  disk_used?: number;
  disk_total?: number;
  net_rx_rate?: number;
  net_tx_rate?: number;
  net_rx_month?: number;
  net_tx_month?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  load_avg?: number[];
  temp?: number;
  swap_pct?: number;
  swap_used?: number;
  swap_total?: number;
  uptime?: number;
  os?: string;
  hostname?: string;
  version?: string;
  cpu_name?: string;
  kernel_version?: string;
  last_seen?: number;
  status?: 'online' | 'offline' | 'warn';
  // 后端 agent 快照的 probes 是 JSON 字符串（`{"目标":{ts,ms,ok,loss}}`），NodeCard 内部 parse
  probes?: string | Record<string, { ts?: number; ms?: number; ok?: boolean; loss?: number }>;
  disk_r_rate?: number;
  disk_w_rate?: number;
  disks?: { mount: string; used: number; total: number; pct: number }[];
  latest?: {
    cpu?: number;
    mem_used?: number;
    mem_total?: number;
    mem_pct?: number;
    disk_used?: number;
    disk_total?: number;
    disk_pct?: number;
    net_rx_rate?: number;
    net_tx_rate?: number;
    net_rx_month?: number;
    net_tx_month?: number;
    load1?: number;
    temp?: number;
    swap_pct?: number;
    uptime?: number;
  };
  // metadata
  merchant?: string;
  note?: string;
  expire_at?: string;
  monthly_quota_gb?: number;
  price?: number;
  billing_cycle?: number;
  currency?: '¥' | '$' | '€' | '£';
  auto_renewal?: boolean;
  probe_targets?: string;
  created_at?: string;
}

export interface Overview {
  total: number;
  online: number;
  offline: number;
  cpu_avg?: number;
  mem_avg?: number;
  groups?: { name: string; total: number; online: number }[];
  db_size_bytes?: number;
}

export interface SparklinePoint {
  ts: number;
  cpu?: number;
  cpu_percent?: number;
  mem_pct?: number;
  disk_pct?: number;
  disk_r_rate?: number;
  disk_w_rate?: number;
  disk_used?: number;
  disk_total?: number;
  net_rx_rate?: number;
  net_tx_rate?: number;
  load1?: number;
  temp?: number;
  swap_pct?: number;
  uptime?: number;
}

export type Sparklines = Record<string, SparklinePoint[]>;

export interface ChartPoint {
  t: number;
  v: number | null;
}

export interface ProbePoint {
  ts: number;
  ms: number;
  ok: boolean;
  loss: number;
}

export type Probes = Record<string, ProbePoint[]>;

export type GlassPreset = 'emerald' | 'soft' | 'high-contrast' | 'midnight' | 'custom';
export type ColorVision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia';
export type CardScheme = 'official' | 'basic' | 'ops' | 'resource' | 'finance' | 'traffic' | 'gpu' | 'asset' | 'full';
export type CardSize = 'mini' | 'compact' | 'comfortable' | 'large';

export interface BackgroundConfig {
  enabled: boolean;
  type: 'image' | 'video';
  url: string;
  blur: number;
  overlay: number;
}
export interface AnnouncementConfig {
  enabled: boolean;
  title: string;
  content: string;
}
export interface GlassCustomColors {
  light?: string[];
  dark?: string[];
}

export interface PublicMeta {
  site_title?: string;
  site_description?: string;
  site_url?: string;
  logo_url?: string;
  custom_css?: string;
  public_theme?: string;
  public_enabled?: boolean;
  // 公开接口是否透出业务字段（商家/到期/备注/配额/套餐）
  public_show_business?: boolean;
  home_layout?: 'grid' | 'list' | 'compact';
  agent_order?: string[];
  social_email?: string;
  social_telegram?: string;
  social_qq?: string;
  social_website?: string;
  // 主题可视化配置（对齐 komari-theme-Glassmorphism）
  glass_preset?: GlassPreset;
  glass_custom?: GlassCustomColors;
  color_vision?: ColorVision;
  card_scheme?: CardScheme;
  card_size?: CardSize;
  background?: BackgroundConfig;
  announcement?: AnnouncementConfig;
  provider_aliases?: Record<string, string>;
  custom_tags?: Record<string, string>;
  visitor_info?: boolean;
}

export interface VersionInfo {
  version: string;
  build_time: string;
}

export interface Settings {
  ui?: Record<string, unknown>;
  notify?: Record<string, unknown>;
}

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'readonly';
}

export interface Alert {
  id: string;
  name: string;
  enabled: boolean;
  condition: string;
}

export interface Billing {
  monthly_total: number;
  currency: string;
  agent_count: number;
  per_group: { name: string; cost: number }[];
  expiring_soon: { id: string; name: string; days_left: number }[];
}

export interface AiConfig {
  enabled: boolean;
  provider?: string;
  base_url?: string;
  model?: string;
  api_key?: string;
  has_key?: boolean;
  schedule_freq?: 'daily' | 'weekly';
  schedule_time?: string;
  tz_offset_hours?: number;
  locale?: 'zh-CN' | 'en';
  log_retention_days?: number;
  silent_days?: number;
  period_hours?: number;
  key_from_env?: boolean;
}

export interface AiStatus {
  enabled: boolean;
  provider?: string;
  model?: string;
  schedule?: string;
  last_run_ts?: number;
  last_status?: string;
  last_error?: string;
  last_duration_ms?: number;
  running?: boolean;
  started_at?: number | null;
  report_count?: number;
}

// GET /api/ai/usage：按 UTC 日的 token 消耗聚合
export interface AiUsageDay {
  day: string;
  reports: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AiUsage {
  days: number;
  total_tokens: number;
  list: AiUsageDay[];
}

// POST /api/ai/analyze-node/:id 的返回值：单节点按需分析（结果缓存 30 分钟）
export interface AiNodeAnalysis {
  status: 'ok' | 'cached' | 'disabled' | 'not_found' | 'error';
  cached?: boolean;
  agent?: { id: string; name: string; online?: boolean };
  analysis?: {
    risk_level?: string;
    summary?: string;
    findings?: Array<{ metric?: string; detail?: string; reason?: string; suggestion?: string }>;
    _parse_error?: boolean;
    raw?: string;
  };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  duration_ms?: number;
  prompt_version?: string;
  message?: string;
}

// POST /api/ai/run 的返回值：异步任务，202 受理 / 400 未启用 / 409 执行中 / 429 冷却
export interface AiRunResult {
  status: 'accepted' | 'disabled' | 'busy' | 'cooldown';
  message?: string;
  retry_after_s?: number;
}

export interface AiReport {
  id: number;
  period?: string;
  risk_level?: string;
  summary?: string;
  suggestion?: string;
  report_json?: string;
  report_json_parsed?: Record<string, unknown>;
  prompt_version?: string;
  created_at: number;
  // 以下字段仅详情接口（getAiReport 的 SELECT *）会返回；老报告可能没有 → 全部可选
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  duration_ms?: number;
  degraded?: number;
}

export interface AiReportList {
  total: number;
  limit: number;
  offset: number;
  list: AiReport[];
}

export interface InstallCommands {
  server_url: string;
  native_cmd: string;
  docker_cmd: string;
  windows_cmd: string;
  probe_targets: string;
}

export interface ModifyCommands {
  linux_cmd: string;
  windows_cmd: string;
  probe_targets: string;
}

// 备份文件条目（来自宿主备份目录，经服务端挂载读取）
export interface BackupFile {
  name: string;
  size_bytes: number;
  mtime: number;
  compressed: boolean;
  kind: 'monitor' | 'pre_restore';
}

export interface BackupList {
  dir: string;
  available: boolean;
  files: BackupFile[];
  restore_request: { file?: string; name?: string; ts?: number } | null;
}

// 数据库备份监控状态（宿主侧 diting.sh 执行后回写服务端）
export interface BackupState {
  last_run_ts?: number;
  last_status?: string;
  last_file?: string;
  last_size_bytes?: number;
  last_raw_bytes?: number;
  last_duration_ms?: number;
  last_error?: string;
  last_pruned?: number;
  backup_count?: number;
  total_bytes?: number;
  updated_at?: number;
}
