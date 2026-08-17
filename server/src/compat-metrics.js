'use strict';
// 第三方主题 Metric API：指标定义、字段映射与 public:queryMetrics 查询。
// 设计为独立模块，便于后续插件追加自定义指标。
const db = require('./db');

// 注意：前端 LoadChart/PingChart 的 le 白名单与 listMetricDefinitions 返回值按【Komari 官方点分命名】匹配
// （如 cpu.usage / load.average / memory.used），因此此处 name 必须与点分命名对齐，否则 Nt() 过滤后为空导致全不渲染。
const METRIC_DEFINITIONS = [
  { name: 'cpu.usage', description: 'CPU 使用率', type: 'percent', unit: '%', retention_days: 30 },
  { name: 'load.average', description: '系统负载', type: 'count', unit: '', retention_days: 30 },
  { name: 'memory.used', description: '内存使用量', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'memory.total', description: '内存总量', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'swap.used', description: '交换分区使用', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'swap.total', description: '交换分区总量', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'temperature', description: '温度', type: 'temperature', unit: '°C', retention_days: 30 },
  { name: 'disk.used', description: '磁盘使用量', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'disk.total', description: '磁盘总量', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'net.in.rate', description: '下行速率', type: 'rate', unit: 'B/s', retention_days: 30 },
  { name: 'net.out.rate', description: '上行速率', type: 'rate', unit: 'B/s', retention_days: 30 },
  { name: 'net.total.down', description: '月累计下行', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'net.total.up', description: '月累计上行', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'traffic.down', description: '月累计下行流量', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'traffic.up', description: '月累计上行流量', type: 'bytes', unit: 'B', retention_days: 30 },
  { name: 'process.count', description: '进程数', type: 'count', unit: '', retention_days: 30 },
  { name: 'connections.tcp', description: 'TCP 连接数', type: 'count', unit: '', retention_days: 30 },
  { name: 'connections.udp', description: 'UDP 连接数', type: 'count', unit: '', retention_days: 30 },
  { name: 'gpu.usage', description: 'GPU 使用率', type: 'percent', unit: '%', retention_days: 30 },
  { name: 'gpu.device.usage', description: 'GPU 设备使用率', type: 'percent', unit: '%', retention_days: 30 },
  { name: 'ping.latency_ms', description: '延迟', type: 'latency', unit: 'ms', retention_days: 30 },
  { name: 'ping.loss', description: '丢包率', type: 'percent', unit: '%', retention_days: 30 }
];

// diting 内部字段名（metrics 表列）映射：键为 Komari 点分命名
const METRIC_FIELD_MAP = {
  'cpu.usage': 'cpu',
  'load.average': 'load1',
  'memory.used': 'mem_used',
  'memory.total': 'mem_total',
  'swap.used': 'mem_used',
  'swap.total': 'mem_total',
  'temperature': 'temp',
  'disk.used': 'disk_used',
  'disk.total': 'disk_total',
  'net.in.rate': 'net_rx_rate',
  'net.out.rate': 'net_tx_rate',
  'net.total.down': 'net_rx_month',
  'net.total.up': 'net_tx_month',
  'traffic.down': 'net_rx_month',
  'traffic.up': 'net_tx_month',
  'process.count': 'cpu',
  'connections.tcp': 'cpu',
  'connections.udp': 'cpu',
  'gpu.usage': 'cpu',
  'gpu.device.usage': 'cpu'
};

function getValue(row, key) {
  const def = METRIC_FIELD_MAP[key];
  if (def == null) return undefined;
  return row[def];
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(v, max));
}

// Komari 官方命名 → diting 内部短命名（用于反向识别与兼容）
const METRIC_KEY_TO_KOMARI = {
  cpu: 'cpu.usage',
  memory: 'memory.used',
  memory_usage: 'memory.usage',
  disk: 'disk.used',
  disk_usage: 'disk.used',
  load: 'load.average',
  net_up: 'net.out.rate',
  net_down: 'net.in.rate',
  traffic_up: 'net.total.up',
  traffic_down: 'net.total.down',
  temperature: 'temperature'
};

function queryMetrics({ metric_keys = [], entity_ids = [], entity_id, hours = 1, maxPoints = 100, max_points } = {}) {
  // 兼容 Komari 官方社区主题参数命名（entity_id 单数 + max_points 下划线）
  if (entity_id != null) entity_ids = [entity_id];
  if (max_points != null) maxPoints = max_points;
  hours = clamp(Math.floor(Number(hours) || 0), 0, 720);
  maxPoints = clamp(Math.floor(Number(maxPoints) || 0), 0, 5000);
  const since = Date.now() - hours * 3600 * 1000;
  const end = new Date().toISOString();
  const start = new Date(since).toISOString();
  const series = [];

  // 分离 ping 类指标（来自 metrics.probes JSON）与普通指标
  const pingKeys = metric_keys.filter(k => k === 'ping.latency_ms' || k === 'ping.loss');
  const normalKeys = metric_keys.filter(k => k !== 'ping.latency_ms' && k !== 'ping.loss');

  // ping.latency_ms / ping.loss：从 metrics.probes 抽延迟，按 entity_id 过滤
  for (const entityId of entity_ids) {
    for (const pk of pingKeys) {
      const rows = (db.getMetricsAll(since) || [])
        .filter(r => r.agent_id === entityId && r.probes != null)
        .slice(0, maxPoints * 10);
      const points = [];
      for (const r of rows) {
        try {
          const probes = JSON.parse(r.probes || '{}');
          const vals = Object.values(probes);
          if (!vals.length) continue;
          // latency_ms 取所有探针平均延迟；loss 取丢失率（此处探针无丢包字段，默认 0）
          if (pk === 'ping.latency_ms') {
            const msVals = vals.map(v => (v && typeof v.ms === 'number') ? v.ms : null).filter(v => v != null);
            if (msVals.length) points.push({ time: new Date(r.ts).toISOString(), value: msVals.reduce((a, b) => a + b, 0) / msVals.length, count: msVals.length });
          } else if (pk === 'ping.loss') {
            points.push({ time: new Date(r.ts).toISOString(), value: 0, count: vals.length });
          }
        } catch (_) {}
      }
      series.push({
        metric_key: pk,
        entity_id: entityId,
        unit: pk === 'ping.latency_ms' ? 'ms' : '%',
        retention_days: 30,
        downsampled: false,
        count: points.length,
        points
      });
    }
  }

  for (const entityId of entity_ids) {
    let rows = db.getMetrics(entityId, since);
    const downsampled = rows.length > maxPoints;
    if (downsampled) {
      const step = Math.ceil(rows.length / maxPoints);
      rows = rows.filter((_, i) => i % step === 0);
    }

    for (const key of normalKeys) {
      // 兼容两种命名：diting 短命名（cpu）或 Komari 官方点分命名（cpu.usage）
      let def = METRIC_DEFINITIONS.find(d => d.name === key);
      if (!def) {
        const ditingName = Object.keys(METRIC_KEY_TO_KOMARI).find(k => METRIC_KEY_TO_KOMARI[k] === key);
        if (ditingName) def = METRIC_DEFINITIONS.find(d => d.name === ditingName);
      }
      if (!def) continue;
      series.push({
        metric_key: METRIC_KEY_TO_KOMARI[key] || key,
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
