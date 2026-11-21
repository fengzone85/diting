'use strict';
// ============================================================
// metrics 表定义单一事实源（审查 P2）。
//
// 同名指标在 5 处各自维护过：建表列、LOAD_COLS、sparklines 列集、
// insertMetric 预编译语句、上报校验区间。任何一处漏改都只会在特定路径上
// 静默出错（例如新列进了建表却进不了 LOAD_COLS，图表永远少一条线）。
// 本文件把「列 + 各路径位次 + 校验区间 + 默认值」收拢为一张表。
//
// 为什么不是一个数组顺序通吃：三条消费路径的列集与列序**各不相同**——
//   1. baseline：001 建表时的历史列（disk_* 在 load* 之前，uptime 在 net_*_month 之后）；
//   2. 迁移追加列（temp/swap_*/…）落在表尾，所以 PRAGMA 列序 = baseline 序 + 追加序；
//   3. LOAD_COLS：22 列子集，load* 在 disk_* 之前，不含 disk_pct/uptime/probes/disks/interval；
//   4. sparklines：又是两个子集（全量采样版含月流量/进程数，旧单节点版不含）。
// 因此每列显式记录 baseline / insertOrder / loadOrder / sparkOrder，
// 生成时按位次排序，测试用字符串快照守护列序，而不是「集合相等」。
// ============================================================

const MEM_MAX = 1024 * 1024 * 1024 * 1024 * 1024; // 字节上限（校验沿用旧口径）

// 校验规则：num = 现有 num() 语义（null → Number(null)=0 仍参与范围判断）；
// nullable = temp 专用（无传感器必须保留 null）；int = 现有 optInt + 「非法归 0」语义。
const V = (min, max) => ({ kind: 'num', min, max });
const VNULL = (min, max) => ({ kind: 'nullable', min, max });
const VINT = (min, max) => ({ kind: 'int', min, max });

const col = (name, type, opts = {}) => ({
  name,
  type,
  notnull: opts.notnull === true,
  pk: opts.pk === true,
  autoinc: opts.autoinc === true,
  dflt: Object.prototype.hasOwnProperty.call(opts, 'dflt') ? opts.dflt : null,
  baseline: opts.baseline !== false,
  insertOrder: opts.insertOrder == null ? null : opts.insertOrder,
  loadOrder: opts.loadOrder == null ? null : opts.loadOrder,
  sparkOrder: opts.sparkOrder == null ? null : opts.sparkOrder,
  // 旧单节点 sparklines（getMetricsSparklines）的子集标记：列序沿用 sparkOrder。
  legacySpark: opts.legacySpark !== false,
  defaults: Object.prototype.hasOwnProperty.call(opts, 'default')
    ? { has: true, value: opts.default }
    : { has: false },
  validate: opts.validate || null,
  // metrics_hour 折叠口径（只做 S7 三方断言，不生成 FOLD_HOUR_SQL）：
  // avg/max/last 对应小时表列名 `<name>_avg` / `<name>_max` / `<name>`；
  // special 为 probes → probes_hour 的异构折叠。
  hour: opts.hour || null,
});

// 声明顺序 = baseline 列 + 迁移追加列，等于空库建表后的 PRAGMA 列序。
const COLUMNS = [
  col('id', 'INTEGER', { pk: true, autoinc: true }),
  col('agent_id', 'TEXT', { notnull: true, insertOrder: 1, loadOrder: 2, sparkOrder: 2 }),
  col('ts', 'INTEGER', { notnull: true, insertOrder: 2, loadOrder: 1, sparkOrder: 1 }),
  col('cpu', 'REAL', {
    insertOrder: 3, loadOrder: 3, sparkOrder: 3, default: 0, validate: V(0, 100), hour: { avg: true, max: true },
  }),
  col('mem_used', 'INTEGER', {
    insertOrder: 4, loadOrder: 4, default: 0, validate: V(0, MEM_MAX), hour: { avg: true },
  }),
  col('mem_total', 'INTEGER', {
    insertOrder: 5, loadOrder: 5, default: 0, validate: V(0, MEM_MAX), hour: { avg: true },
  }),
  col('mem_pct', 'REAL', {
    insertOrder: 6, loadOrder: 6, sparkOrder: 4, default: 0, validate: V(0, 100), hour: { avg: true, max: true },
  }),
  col('disk_used', 'INTEGER', {
    insertOrder: 7, loadOrder: 14, sparkOrder: 16, default: 0, validate: V(0, MEM_MAX), hour: { avg: true },
  }),
  col('disk_total', 'INTEGER', {
    insertOrder: 8, loadOrder: 15, sparkOrder: 17, default: 0, validate: V(0, MEM_MAX), hour: { avg: true },
  }),
  col('disk_pct', 'REAL', {
    insertOrder: 9, sparkOrder: 5, default: 0, validate: V(0, 100), hour: { avg: true, max: true },
  }),
  col('load1', 'REAL', {
    insertOrder: 10, loadOrder: 7, sparkOrder: 10, default: 0, validate: V(0, 1e6), hour: { avg: true, max: true },
  }),
  col('load5', 'REAL', {
    insertOrder: 11, loadOrder: 8, default: 0, validate: V(0, 1e6), hour: { avg: true },
  }),
  col('load15', 'REAL', {
    insertOrder: 12, loadOrder: 9, default: 0, validate: V(0, 1e6), hour: { avg: true },
  }),
  col('net_rx_rate', 'REAL', {
    insertOrder: 13, loadOrder: 10, sparkOrder: 6, default: 0, validate: V(0, 1e15), hour: { avg: true, max: true },
  }),
  col('net_tx_rate', 'REAL', {
    insertOrder: 14, loadOrder: 11, sparkOrder: 7, default: 0, validate: V(0, 1e15), hour: { avg: true, max: true },
  }),
  col('net_rx_month', 'INTEGER', {
    insertOrder: 15, loadOrder: 12, sparkOrder: 8, legacySpark: false, default: 0, validate: V(0, 1e18), hour: { last: true },
  }),
  col('net_tx_month', 'INTEGER', {
    insertOrder: 16, loadOrder: 13, sparkOrder: 9, legacySpark: false, default: 0, validate: V(0, 1e18), hour: { last: true },
  }),
  col('uptime', 'REAL', {
    insertOrder: 17, sparkOrder: 13, default: 0, validate: V(0, 1e12), hour: { avg: true },
  }),

  // ---- 以下为 002 迁移追加列（baseline:false）：建表时不存在，ALTER 追加在表尾 ----
  col('temp', 'REAL', {
    baseline: false, insertOrder: 18, loadOrder: 21, sparkOrder: 11, default: null,
    validate: VNULL(-50, 200), hour: { avg: true, max: true },
  }),
  col('swap_used', 'INTEGER', {
    baseline: false, insertOrder: 19, loadOrder: 18, default: 0, validate: V(0, MEM_MAX), hour: { avg: true },
  }),
  col('swap_total', 'INTEGER', {
    baseline: false, insertOrder: 20, loadOrder: 19, default: 0, validate: V(0, MEM_MAX), hour: { avg: true },
  }),
  col('swap_pct', 'REAL', {
    baseline: false, insertOrder: 21, loadOrder: 20, sparkOrder: 12, default: 0, validate: V(0, 100), hour: { avg: true },
  }),
  // probes/disks 是 JSON 文本，校验由 validate.js 的专用清洗函数负责（不参与数值裁剪）。
  col('probes', 'TEXT', {
    baseline: false, insertOrder: 24, default: '{}', hour: { special: 'probes_hour' },
  }),
  col('disk_r_rate', 'REAL', {
    baseline: false, insertOrder: 22, loadOrder: 16, sparkOrder: 14, default: 0, validate: V(0, 1e15), hour: { max: true },
  }),
  col('disk_w_rate', 'REAL', {
    baseline: false, insertOrder: 23, loadOrder: 17, sparkOrder: 15, default: 0, validate: V(0, 1e15), hour: { max: true },
  }),
  col('disks', 'TEXT', { baseline: false, insertOrder: 25, default: '[]' }),
  col('process_count', 'INTEGER', {
    baseline: false, dflt: 0, insertOrder: 26, loadOrder: 22, sparkOrder: 18, legacySpark: false,
    default: 0, validate: VINT(0, 100000), hour: { max: true },
  }),
  col('interval', 'INTEGER', {
    baseline: false, dflt: 0, insertOrder: 27, default: 0, validate: VINT(0, 86400),
  }),
];

const byOrder = (key, filter) => COLUMNS
  .filter((c) => c[key] != null && (!filter || filter(c)))
  .sort((a, b) => a[key] - b[key]);

// 列定义片段（不含缩进/逗号），建表与迁移共用。
function columnDdl(c) {
  const parts = [c.type];
  if (c.notnull) parts.push('NOT NULL');
  if (c.pk) parts.push('PRIMARY KEY');
  if (c.autoinc) parts.push('AUTOINCREMENT');
  if (c.dflt != null) parts.push(`DEFAULT ${c.dflt}`);
  return parts.join(' ');
}

// 001 建表列片段：只含 baseline 列，按声明序，名称补到 14 列宽（与历史 SQL 对齐）。
function buildCreateMetricsSql() {
  return COLUMNS.filter((c) => c.baseline)
    .map((c) => `  ${c.name.padEnd(14)}${columnDdl(c)},`)
    .join('\n');
}

// 002 迁移复用：追加列 [name, ddl] 列表，顺序与声明序一致。
function buildAppendColumns() {
  return COLUMNS.filter((c) => !c.baseline).map((c) => [c.name, columnDdl(c)]);
}

function buildLoadColsSql() {
  return byOrder('loadOrder').map((c) => c.name).join(', ');
}

// legacy=true 生成旧单节点 sparklines 子集（不含月流量与进程数）。
function buildSparkColsSql(legacy) {
  return byOrder('sparkOrder', legacy ? (c) => c.legacySpark : null).map((c) => c.name).join(', ');
}

function buildInsertSql() {
  const columns = byOrder('insertOrder').map((c) => c.name);
  return {
    columns,
    sql: `INSERT INTO metrics
    (${columns.join(', ')})
    VALUES (${columns.map((n) => `@${n}`).join(', ')})`,
  };
}

// 兜底默认值：按 insertOrder 输出，与旧的 METRIC_DEFAULTS 键序一致。
function buildMetricDefaults() {
  const out = {};
  for (const c of byOrder('insertOrder')) {
    if (c.defaults.has) out[c.name] = c.defaults.value;
  }
  return out;
}

// 与 validate.js 的 num() 完全同义：Number() 强制转换，非有限数/越界 → null。
const num = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
};

// 上报负载的指标列校验（probes/disks 由 validate.js 专用函数处理）。
function validateMetricPayload(b) {
  const out = {};
  for (const c of COLUMNS) {
    const r = c.validate;
    if (!r) continue;
    if (r.kind === 'int') {
      // 旧实现：Math.floor(num(...) || 0)，缺失/非法一律 0。
      out[c.name] = Math.floor(num(b[c.name], r.min, r.max) || 0);
    } else if (r.kind === 'nullable') {
      out[c.name] = (b[c.name] === null || b[c.name] === undefined) ? null : num(b[c.name], r.min, r.max);
    } else {
      out[c.name] = num(b[c.name], r.min, r.max);
    }
  }
  return out;
}

module.exports = {
  COLUMNS,
  CREATE_METRICS_SQL: buildCreateMetricsSql(),
  APPEND_COLUMNS: buildAppendColumns(),
  LOAD_COLS_SQL: buildLoadColsSql(),
  SPARK_COLS_SQL: buildSparkColsSql(false),
  SPARK_LEGACY_COLS_SQL: buildSparkColsSql(true),
  INSERT_SQL: buildInsertSql(),
  METRIC_DEFAULTS: buildMetricDefaults(),
  validateMetricPayload,
  // 生成器同时导出：测试注入假列后需按当前 COLUMNS 重新生成（模块常量已固化）。
  buildCreateMetricsSql,
  buildAppendColumns,
  buildLoadColsSql,
  buildSparkColsSql,
  buildInsertSql,
  buildMetricDefaults,
};
