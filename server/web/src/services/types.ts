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
  load_avg?: number[];
  temp?: number;
  swap_pct?: number;
  uptime?: number;
  os?: string;
  hostname?: string;
  version?: string;
  last_seen?: number;
  status?: 'online' | 'offline' | 'warn';
  probes?: Record<string, { ts: number; ms: number; ok: boolean; loss: number }[]>;
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
}

export interface SparklinePoint {
  ts: number;
  cpu?: number;
  mem_pct?: number;
  disk_pct?: number;
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
  v: number;
}

export interface ProbePoint {
  ts: number;
  ms: number;
  ok: boolean;
  loss: number;
}

export type Probes = Record<string, ProbePoint[]>;

export interface PublicMeta {
  site_title?: string;
  site_description?: string;
  site_url?: string;
  logo_url?: string;
  custom_css?: string;
  public_theme?: string;
  public_enabled?: boolean;
  home_layout?: 'grid' | 'list' | 'compact';
  agent_order?: string[];
  social_email?: string;
  social_telegram?: string;
  social_qq?: string;
  social_website?: string;
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
