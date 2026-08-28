export function formatBytes(bytes: number | undefined, decimals = 2): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '-';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function formatBitsPerSecond(bps: number | undefined, decimals = 2): string {
  if (bps === undefined || bps === null || Number.isNaN(bps)) return '-';
  if (bps === 0) return '0 bps';
  const k = 1000;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const i = Math.floor(Math.log(bps) / Math.log(k));
  return `${parseFloat((bps / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// 磁盘读写速率（受控端采集为 B/s）。坐标轴标签用 decimals=1 更紧凑，
// 基准 1024 与 formatBytes 保持一致（存储容量同惯例）；后缀带 /s 与容量单位区分。
export function formatBytesPerSecond(bps: number | undefined, decimals = 2): string {
  if (bps === undefined || bps === null || Number.isNaN(bps)) return '-';
  if (bps === 0) return '0 B/s';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  const i = Math.min(Math.floor(Math.log(bps) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bps / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || seconds === null || Number.isNaN(seconds)) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) return '<1m';
  return parts.join(' ');
}

export function formatPercent(v: number | undefined, decimals = 1): string {
  if (v === undefined || v === null || Number.isNaN(v)) return '-';
  return `${v.toFixed(decimals)}%`;
}

export function formatNumber(v: number | undefined, decimals = 2): string {
  if (v === undefined || v === null || Number.isNaN(v)) return '-';
  return v.toFixed(decimals);
}

// 货币格式化：拼接 currency 符号与数值（如 ¥50）
export function formatCurrency(v: number | undefined, currency = '¥'): string {
  if (v === undefined || v === null || Number.isNaN(v)) return '-';
  return `${currency}${formatNumber(v, 2)}`;
}

// 剩余时间格式化：基于到期时间戳返回「X 月 Y 天」/「已过期」/「长期」
export function formatRemaining(expireAt: string | undefined): { text: string; status: 'expired' | 'critical' | 'warning' | 'long_term' | 'normal' } {
  if (!expireAt) return { text: '—', status: 'long_term' };
  const exp = new Date(expireAt).getTime();
  if (Number.isNaN(exp)) return { text: '—', status: 'long_term' };
  const ms = exp - Date.now();
  if (ms <= 0) return { text: '已过期', status: 'expired' };
  const dayMs = 86400000;
  const days = Math.floor(ms / dayMs);
  const months = Math.floor(days / 30);
  const remDays = days % 30;
  let status: 'critical' | 'warning' | 'long_term' | 'normal' = 'normal';
  if (days <= 7) status = 'critical';
  else if (days <= 30) status = 'warning';
  else if (days > 365) status = 'long_term';
  const text = months > 0 ? `${months} 月 ${remDays} 天` : `${days} 天`;
  return { text, status };
}

