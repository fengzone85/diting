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

// diting 内部字段名（metrics 表列）映射：键为 Komari 点分命名。
//
// 只保留【diting 真实采集】的字段。此前 5 条占位映射
// （process.count/connections.tcp/connections.udp/gpu.usage/gpu.device.usage → 'cpu'）
// 会让 CPU 值冒充 GPU/进程/连接数渲染成图 —— 属「错值」，比缺图更危险（体检 L-5）。
// 已删除：无映射 → queryMetrics 不生成该 series（宁可缺图，不可错值）。
// METRIC_DEFINITIONS 中对应定义【保留】：前端按 definitions 匹配 le 白名单，
// 删定义可能引发空渲染异常，故仅断开数据映射。
const METRIC_FIELD_MAP = {
  'cpu.usage': 'cpu',
  'load.average': 'load1',
  'memory.used': 'mem_used',
  'memory.total': 'mem_total',
  // swap 修正（体检复核新发现）：原先错映射到 memory 列，导致 Swap 图渲染内存值。
  // swap_used / swap_total 是 metrics 表真实列（diting 一直在采），属真实映射修复。
  'swap.used': 'swap_used',
  'swap.total': 'swap_total',
  'temperature': 'temp',
  'disk.used': 'disk_used',
  'disk.total': 'disk_total',
  'net.in.rate': 'net_rx_rate',
  'net.out.rate': 'net_tx_rate',
  'net.total.down': 'net_rx_month',
  'net.total.up': 'net_tx_month',
  'traffic.down': 'net_rx_month',
  'traffic.up': 'net_tx_month'
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
  // 长度钳制（体检 L-5 附带项）：防单请求携带超大数组导致 N 次 SQL 循环。
  // 50 = Komari 官方 UI 单页节点上限；32 = 单次查询的合理指标数上限。
  if (!Array.isArray(entity_ids)) entity_ids = [];
  if (!Array.isArray(metric_keys)) metric_keys = [];
  entity_ids = entity_ids.slice(0, 50);
  metric_keys = metric_keys.slice(0, 32);
  const since = Date.now() - hours * 3600 * 1000;
  const end = new Date().toISOString();
  const start = new Date(since).toISOString();
  const series = [];

  // 分离 ping 类指标（来自 metrics.probes JSON）与普通指标
  const pingKeys = metric_keys.filter(k => k === 'ping.latency_ms' || k === 'ping.loss');
  const normalKeys = metric_keys.filter(k => k !== 'ping.latency_ms' && k !== 'ping.loss');

  // ping.latency_ms / ping.loss：从 metrics.probes 抽延迟，【按探针任务(task)拆分】多条 series，
  // 以对齐 Komari 社区主题 PingChart 的期望结构（series 每项需含 task_id + points:[{time,value}]）。
  // diting 的 probes JSON 形如 { "移动": {ms, ok, loss}, "联通": {...}, ... }，每个 key 即一个 task。
  for (const entityId of entity_ids) {
    // L-7：按实体【独立】在 SQL 层采样（替代「全局采样 + JS filter」）。
    // 旧实现先跨节点取 maxPoints*10 行再 filter 本实体，多节点时本实体只分到零头 →
    // 单节点曲线稀疏甚至为空。改走 getMetricsProbesOne 后每个实体各自拿满配额。
    const rows = (db.getMetricsProbesOne(entityId, since, Math.max(200, maxPoints * 10)) || [])
      .filter(r => r.probes != null)
      .slice(0, maxPoints * 10);
    // 收集该 entity 所有 task 名称
    const taskNames = new Set();
    rows.forEach(r => {
      try { Object.keys(JSON.parse(r.probes || '{}')).forEach(n => taskNames.add(n)); } catch (_) {}
    });
    for (const pk of pingKeys) {
      for (const taskName of taskNames) {
        const points = [];
        for (const r of rows) {
          try {
            const probes = JSON.parse(r.probes || '{}');
            const v = probes[taskName];
            if (!v) continue;
            if (pk === 'ping.latency_ms') {
              if (typeof v.ms === 'number') points.push({ time: new Date(r.ts).toISOString(), value: v.ms, count: 1 });
            } else if (pk === 'ping.loss') {
              points.push({ time: new Date(r.ts).toISOString(), value: Number(v.loss) || 0, count: 1 });
            }
          } catch (_) {}
        }
        if (!points.length) continue;
        series.push({
          metric_key: pk,
          entity_id: entityId,
          task_id: taskName,
          name: taskName,
          unit: pk === 'ping.latency_ms' ? 'ms' : '%',
          retention_days: 30,
          downsampled: false,
          count: points.length,
          points
        });
      }
    }
  }

  for (const entityId of entity_ids) {
    // M-02：SQL 层均匀采样（保留首尾点），只取负载列，不再「全量拉取后 JS filter」
    // （ping 类指标走上面的 metricsProbesAll，此处只服务 METRIC_DEFINITIONS 中的负载列）
    const rows = db.getMetricsLoadOne(entityId, since, Math.max(1, maxPoints));
    // 采样已在 SQL 层完成：返回点数贴着 maxPoints 即说明发生过降采样
    const downsampled = rows.length >= maxPoints;

    for (const key of normalKeys) {
      // 兼容两种命名：diting 短命名（cpu）或 Komari 官方点分命名（cpu.usage）
      let def = METRIC_DEFINITIONS.find(d => d.name === key);
      if (!def) {
        const ditingName = Object.keys(METRIC_KEY_TO_KOMARI).find(k => METRIC_KEY_TO_KOMARI[k] === key);
        if (ditingName) def = METRIC_DEFINITIONS.find(d => d.name === ditingName);
      }
      if (!def) continue;
      // 无真实数据源：不生成 series（体检 L-5）。
      // 宁可缺图，不可错值 —— v1.js CAPABILITY 已声明 process/connections/gpu 能力为 false。
      const field = METRIC_FIELD_MAP[key];
      if (!field) continue;
      // 该字段在所有采样行上均无有效值（如缺温度传感器）→ 不生成全 0 的假曲线
      const hasValue = rows.some(r => r[field] != null);
      if (!hasValue) continue;
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
