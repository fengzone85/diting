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
  // 受控端上报的 CPU 核数（§9 T18）：0/null = 未上报（老 agent），不可当 1 用
  cores?: number;
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
  // 进程总数（Windows 卡片显示；0/null = 未采集/老 agent）
  process_count?: number;
  temp?: number;
  swap_pct?: number;
  swap_used?: number;
  swap_total?: number;
  uptime?: number;
  // F7：30 天在线率（%，1 位小数）；null/缺失 = 还没有 session 记录
  uptime_30d?: number | null;
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
  // P3 流量周期：month_rotate 三态（undefined=老数据，null=采纳 agent 上报，0=累计，1–31=重置日）
  month_rotate?: number | null;
  has_counter?: boolean;
  price?: number;
  billing_cycle?: number;
  // 对齐 Komari：¥ 人民币 / $ 美元 / € 欧元 / £ 英镑 / ₽ 卢布 / ₣ 法郎 / ₹ 卢比 / ₫ 越南盾 / ฿ 泰铢
  currency?: '¥' | '$' | '€' | '£' | '₽' | '₣' | '₹' | '₫' | '฿';
  // 服务端计费折算（server/src/billing.js，对齐 Komari 剩余价值口径）
  remaining_days?: number | null;
  remaining_value?: number | null;
  monthly_cost?: number | null;
  billing_status?: 'unset' | 'free' | 'long_term' | 'one_off' | 'expired' | 'active' | 'invalid';
  auto_renewal?: boolean;
  probe_targets?: string;
  created_at?: string;
  // S1/F1：告警规则解析结果（服务端下发，前端只渲染不重算）
  alert?: {
    effective: AlertThresholds;
    overridden: boolean;
    muted: boolean;
  };
}

// F11：最近删除（软删节点，7 天缓冲期内可恢复）
export interface DeletedAgent {
  id: string;
  name: string;
  hostname?: string;
  version?: string;
  deleted_at: number;
  days_left: number;
}

// ---- S1/F1 告警规则覆盖 ----
export interface AlertThresholds {
  offline_sec: number;
  cpu_pct: number;
  mem_pct: number;
  disk_pct: number;
  temp_c: number;
  cooldown: number;
}
// 覆盖行：字段为 null 表示继承上层（分组 > 全局）；muted 为 0/1
export interface AlertOverride {
  offline_sec: number | null;
  cpu_pct: number | null;
  mem_pct: number | null;
  disk_pct: number | null;
  temp_c: number | null;
  cooldown: number | null;
  muted: number;
  updated_at?: number;
}
export interface AlertOverrideInput {
  offline_sec?: number | null;
  cpu_pct?: number | null;
  mem_pct?: number | null;
  disk_pct?: number | null;
  temp_c?: number | null;
  cooldown?: number | null;
  muted?: boolean;
}
export interface AlertRules {
  global: AlertThresholds;
  groups: (AlertOverride & { grp: string })[];
  agents: (AlertOverride & { agent_id: string })[];
}

// ---- S1/F2：通知渠道与通知组 ----
export interface WebhookConfig {
  url: string;
  method: 'GET' | 'POST';
  content_type: 'json' | 'form';
  headers: Record<string, string>;
  body_template: string;
  verify_tls: boolean;
}
export interface NotifyChannel {
  id: number;
  type: 'mail' | 'telegram' | 'webhook';
  name: string;
  enabled: boolean;
  config: Partial<WebhookConfig>;
  created_at?: number;
  updated_at?: number;
}
export interface NotifyGroup {
  id: number;
  name: string;
  enabled: boolean;
  events: string[];
  channel_ids: number[];
  created_at?: number;
  updated_at?: number;
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
  process_count?: number;
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
  ms: number | null;
  // S3 三态：true=可达、false=不可达、null=无采样（解析超时）
  ok: boolean | null;
  loss: number | null;
}

export type Probes = Record<string, ProbePoint[]>;

// F7：在线时段（/agents/:id/online-history 与 /public/... 同结构）。
// pct 的分母是「当天已过去的时间」，所以今天不会是整天；null = 窗口内无数据。
export interface OnlineDay {
  date: string;
  up_sec: number;
  pct: number | null;
}

export interface OnlineOutage {
  started_at: number;
  ended_at: number | null; // null = 仍在离线
  duration_sec: number;
}

export interface OnlineHistory {
  days: number;
  since: number;
  now: number;
  daily: OnlineDay[];
  outages: OnlineOutage[];
  uptime_pct: number | null;
}

// F4：探测可用率聚合（/probes?availability=1）。
// up_pct 的分母是窗口内全部采样点；unreachable 表示窗口内无一成功
// （多半是目标本身不可达，如运营商 DNS 拒绝 TCP），不应显示成「0% 可用」。
export interface ProbeAvailability {
  up_pct: number | null;
  samples: number;
  down_samples: number;
  avg_ms: number | null;
  max_ms: number | null;
  last_down_at: number | null;
  unreachable: boolean;
  type: 'tcp' | 'http';
  code: number | null;
  cert_days: number | null;
  cert_ts: number | null;
}

export interface ProbesDetailed {
  series: Probes;
  availability: Record<string, ProbeAvailability>;
}

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

// F12 容量保险丝状态（行数 + 库文件双水位）
export interface CapacityStatus {
  enabled: boolean;
  level: 'ok' | 'warn' | 'full';
  rows: number;
  bytes: number;
  max_rows: number;
  max_bytes: number;
  row_pct: number;
  byte_pct: number;
  pct: number;
  paused: boolean;
  skipped: number;
  retention_days: number;
  ts: number;
  deleted?: number;
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

// 后台仪表盘布局（对齐 Komari）：宽度三档、高度三档，数组顺序即渲染顺序
export type DashboardWidgetWidth = 'compact' | 'wide' | 'full';
export type DashboardWidgetHeight = 'short' | 'normal' | 'tall';
export interface DashboardLayoutItem {
  id: string;
  width: DashboardWidgetWidth;
  height: DashboardWidgetHeight;
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
  node_cache_ttl_minutes?: number;
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

// GET /api/ai/node-reports 的单项：单节点分析历史（不含 report_json）
export interface AiNodeReportItem {
  id: number;
  agent_id: string;
  period_hours: number;
  status: string;
  risk_level?: string;
  prompt_version?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  duration_ms?: number;
  created_at: number;
}

// POST /api/ai/analyze-node/:id 的返回值：单节点按需分析（结果缓存 30 分钟）
export interface AiNodeAnalysis {
  status: 'ok' | 'cached' | 'disabled' | 'not_found' | 'error';
  cached?: boolean;
  agent?: { id: string; name: string; online?: boolean };
  period_hours?: number;
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
  // F8.3：列表抽查（quick_check）结果；恢复前会再做一次完整 integrity_check
  integrity?: 'ok' | 'fail' | 'unknown';
  integrity_reason?: string;
}

// F8.6：恢复后一致性审查（服务端启动时写入，本页只读展示）
export interface RestoreAuditCheck {
  id: string;
  status: 'ok' | 'warn' | 'skipped' | 'fail';
  value: Record<string, unknown>;
}

export interface RestoreAuditSummary {
  ok: number;
  warn: number;
  skipped: number;
  fail: number;
  total_rows: number;
  expired_rows: number;
  orphan_deleted: number;
  purged_agents: number;
  traffic_gap_fixed: number;
}

export interface RestoreAuditReport {
  ts: number;
  backup: { name: string; ts: number; mtime?: number; by: string };
  source: 'db' | 'file';
  duration_ms: number;
  retention_days: number | null;
  fatal: boolean;
  error: string;
  checks: RestoreAuditCheck[];
  summary: RestoreAuditSummary;
}

export interface BackupList {
  dir: string;
  available: boolean;
  files: BackupFile[];
  restore_request: { file?: string; name?: string; ts?: number } | null;
  restore_audit?: RestoreAuditReport | null;
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

// S2/F5：API Token（明文只在创建响应中出现一次；列表接口不含明文与哈希）
export interface ApiToken {
  id: string;
  name: string;
  scope: 'readonly' | 'admin';
  agent_ids: string[];
  expires_at: number;
  last_used_at: number;
  last_used_ip: string;
  created_at: number;
  created_by: string;
  revoked: boolean;
}

export interface ApiTokenCreated {
  id: string;
  name: string;
  scope: 'readonly' | 'admin';
  agent_ids: string[];
  expires_at: number;
  token: string;
  notice: string;
}

// S2/F6：登录会话（后台「会话管理」页）。current=true 表示发起本次请求的那台设备。
export interface AdminSession {
  id: string;
  admin: string;
  ip: string;
  ua: string;
  created_at: number;
  last_seen: number;
  current: boolean;
}
