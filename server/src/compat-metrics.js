'use strict';
// 第三方主题 Metric API：指标定义、字段映射与 public:queryMetrics 查询。
// 设计为独立模块，便于后续插件追加自定义指标。
const db = require('./db');

const METRIC_DEFINITIONS = [
  { name: 'cpu', description: 'CPU 使用率', type: 'percent', unit: '%', retention_days: 30 },
  { name: 'memory', description: '内存使用量', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'memory_usage', description: '内存使用率', type: 'percent', unit: '%', retention_days: 30 },
  { name: 'disk', description: '磁盘使用量', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'disk_usage', description: '磁盘使用率', type: 'percent', unit: '%', retention_days: 30 },
  { name: 'load', description: '系统负载', type: 'count', unit: '', retention_days: 30 },
  { name: 'net_up', description: '上行速率', type: 'rate', unit: 'B/s', retention_days: 30 },
  { name: 'net_down', description: '下行速率', type: 'rate', unit: 'B/s', retention_days: 30 },
  { name: 'traffic_up', description: '月累计上行', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'traffic_down', description: '月累计下行', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'uptime', description: '运行时间', type: 'duration', unit: 's', retention_days: 30 },
  { name: 'temperature', description: '温度', type: 'temperature', unit: '°C', retention_days: 30 }
];

const METRIC_FIELD_MAP = {
  cpu: 'cpu',
  memory: 'mem_used',
  memory_usage: (m) => m.mem_total > 0 ? (m.mem_used / m.mem_total) * 100 : 0,
  disk: 'disk_used',
  disk_usage: (m) => m.disk_total > 0 ? (m.disk_used / m.disk_total) * 100 : 0,
  load: 'load1',
  net_up: 'net_tx_rate',
  net_down: 'net_rx_rate',
  traffic_up: 'net_tx_month',
  traffic_down: 'net_rx_month',
  uptime: 'uptime',
  temperature: 'temp'
};

function getValue(row, key) {
  const def = METRIC_FIELD_MAP[key];
  if (typeof def === 'function') return def(row);
  return row[def];
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(v, max));
}

function queryMetrics({ metric_keys = [], entity_ids = [], hours = 1, maxPoints = 100 } = {}) {
  hours = clamp(Math.floor(Number(hours) || 0), 0, 720);
  maxPoints = clamp(Math.floor(Number(maxPoints) || 0), 0, 5000);
  const since = Date.now() - hours * 3600 * 1000;
  const end = new Date().toISOString();
  const start = new Date(since).toISOString();
  const series = [];

  for (const entityId of entity_ids) {
    let rows = db.getMetrics(entityId, since);
    const downsampled = rows.length > maxPoints;
    if (downsampled) {
      const step = Math.ceil(rows.length / maxPoints);
      rows = rows.filter((_, i) => i % step === 0);
    }

    for (const key of metric_keys) {
      const def = METRIC_DEFINITIONS.find(d => d.name === key);
      if (!def) continue;
      series.push({
        metric_key: key,
        entity_id: entityId,
        unit: def.unit,
        retention_days: def.retention_days,
        downsampled,
        count: rows.length,
        points: rows.map(r => ({
          time: new Date(r.ts).toISOString(),
          value: Number(getValue(r, key)) || 0,
          count: 1
        }))
      });
    }
  }

  return { start, end, series, count: series.length };
}

module.exports = { METRIC_DEFINITIONS, METRIC_FIELD_MAP, queryMetrics };
