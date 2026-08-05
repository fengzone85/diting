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
