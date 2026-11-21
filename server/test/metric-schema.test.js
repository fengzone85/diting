// ============================================================
// metrics 定义单一事实源守护（A 批）。
//
// 守护目标不是「函数能跑」，而是「定义只有一处」：
//   S1 注入假列后，建表/LOAD/sparkline/默认值/校验五条路径必须自动跟上；
//   S2 三条消费路径的列序分别做字符串快照（它们的列集与列序各不相同）；
//   S3 schema 声明序 = 实际建表后的 PRAGMA 列序（baseline 序 + 追加序）；
//   S4 insertMetric 的具名参数集合 = schema 的 insert 列集；
//   S5 校验结果与旧实现（固定写在本文件里的对照函数）逐值相等；
//   S6 METRIC_DEFAULTS 与旧常量逐键相等；
//   S7 schema 的小时聚合标记 ↔ metrics_hour 实际列 ↔ FOLD_HOUR_SQL 三方一致。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const schema = require('../src/metric-schema');
const { runMigrations } = require('../src/migrations');

const ROLLUP_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'rollup.js'), 'utf8');

function openDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-ms-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, 'monitor.db'));
  t.after(() => { try { db.close(); } catch { /* 已关闭 */ } });
  return db;
}

// ---- 旧实现对照（S5）------------------------------------------------------
const legacyNum = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
};
function legacyValue(rule, v) {
  if (rule.kind === 'int') return Math.floor(legacyNum(v, rule.min, rule.max) || 0);
  if (rule.kind === 'nullable') return (v === null || v === undefined) ? null : legacyNum(v, rule.min, rule.max);
  return legacyNum(v, rule.min, rule.max);
}

test('S1 假列注入：五条消费路径自动包含，无需改第二处', () => {
  const fake = {
    name: 'fake_metric', type: 'REAL', notnull: false, pk: false, autoinc: false, dflt: null,
    baseline: true, insertOrder: 100, loadOrder: 100, sparkOrder: 100, legacySpark: true,
    defaults: { has: true, value: 0 },
    validate: { kind: 'num', min: 0, max: 1 },
    hour: null,
  };
  schema.COLUMNS.push(fake);
  try {
    assert.match(schema.buildCreateMetricsSql(), /fake_metric\s+REAL/, '建表列');
    assert.match(schema.buildLoadColsSql(), /fake_metric/, 'LOAD_COLS');
    assert.match(schema.buildSparkColsSql(false), /fake_metric/, 'sparklines');
    assert.match(schema.buildSparkColsSql(true), /fake_metric/, 'sparklines(legacy)');
    assert.strictEqual(schema.buildMetricDefaults().fake_metric, 0, 'METRIC_DEFAULTS');
    assert.strictEqual(schema.validateMetricPayload({ fake_metric: 0.5 }).fake_metric, 0.5, '校验通过');
    assert.strictEqual(schema.validateMetricPayload({ fake_metric: 2 }).fake_metric, null, '校验越界');
  } finally {
    schema.COLUMNS.pop();
  }
});

test('S2a 建表列片段快照（baseline 列，按声明序）', () => {
  assert.strictEqual(schema.CREATE_METRICS_SQL, [
    '  id            INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  agent_id      TEXT NOT NULL,',
    '  ts            INTEGER NOT NULL,',
    '  cpu           REAL,',
    '  mem_used      INTEGER,',
    '  mem_total     INTEGER,',
    '  mem_pct       REAL,',
    '  disk_used     INTEGER,',
    '  disk_total    INTEGER,',
    '  disk_pct      REAL,',
    '  load1         REAL,',
    '  load5         REAL,',
    '  load15        REAL,',
    '  net_rx_rate   REAL,',
    '  net_tx_rate   REAL,',
    '  net_rx_month  INTEGER,',
    '  net_tx_month  INTEGER,',
    '  uptime        REAL,',
  ].join('\n'));
});

test('S2b LOAD_COLS 快照（loadOrder）', () => {
  assert.strictEqual(
    schema.LOAD_COLS_SQL,
    'ts, agent_id, cpu, mem_used, mem_total, mem_pct, load1, load5, load15, '
    + 'net_rx_rate, net_tx_rate, net_rx_month, net_tx_month, disk_used, disk_total, '
    + 'disk_r_rate, disk_w_rate, swap_used, swap_total, swap_pct, temp, process_count',
  );
});

test('S2c sparklines 列片段快照（sparkOrder；全量采样版与 legacy 子集分别守护）', () => {
  assert.strictEqual(
    schema.SPARK_COLS_SQL,
    'ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate, '
    + 'net_rx_month, net_tx_month, load1, temp, swap_pct, uptime, '
    + 'disk_r_rate, disk_w_rate, disk_used, disk_total, process_count',
  );
  assert.strictEqual(
    schema.SPARK_LEGACY_COLS_SQL,
    'ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate, '
    + 'load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total',
  );
});

test('S3 schema ↔ 实际表：PRAGMA 列序 = baseline 声明序 + 追加声明序', (t) => {
  const db = openDb(t);
  runMigrations(db);
  const info = db.prepare('PRAGMA table_info(metrics)').all();

  assert.deepStrictEqual(info.map((r) => r.name), schema.COLUMNS.map((c) => c.name));
  for (const row of info) {
    const c = schema.COLUMNS.find((x) => x.name === row.name);
    assert.strictEqual(row.type, c.type, `${row.name}.type`);
    assert.strictEqual(row.notnull, c.notnull ? 1 : 0, `${row.name}.notnull`);
    assert.strictEqual(row.pk, c.pk ? 1 : 0, `${row.name}.pk`);
    assert.strictEqual(row.dflt_value == null ? null : String(row.dflt_value),
      c.dflt == null ? null : String(c.dflt), `${row.name}.dflt`);
  }
});

test('S4 insertMetric 具名参数集合 = schema 的 insert 列集', () => {
  const expected = schema.COLUMNS
    .filter((c) => c.insertOrder != null)
    .sort((a, b) => a.insertOrder - b.insertOrder)
    .map((c) => c.name);
  assert.deepStrictEqual(schema.INSERT_SQL.columns, expected);

  const params = [...schema.INSERT_SQL.sql.matchAll(/@([a-z][a-z0-9_]*)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(params)], expected);
});

test('S5 校验等价：每个数值列与旧实现逐值一致', () => {
  for (const c of schema.COLUMNS) {
    if (!c.validate) continue;
    const { min, max } = c.validate;
    const values = [
      min - 1, min, max, max + 1, 'x', undefined, null,
      String(min), (min + max) / 2,
    ];
    for (const v of values) {
      const got = schema.validateMetricPayload({ [c.name]: v })[c.name];
      assert.strictEqual(got, legacyValue(c.validate, v), `${c.name} <- ${String(v)}`);
    }
  }
});

test('S6 METRIC_DEFAULTS 与旧常量逐键相等', () => {
  assert.deepStrictEqual(schema.METRIC_DEFAULTS, {
    cpu: 0, mem_used: 0, mem_total: 0, mem_pct: 0,
    disk_used: 0, disk_total: 0, disk_pct: 0,
    load1: 0, load5: 0, load15: 0,
    net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0, uptime: 0,
    temp: null, swap_used: 0, swap_total: 0, swap_pct: 0,
    disk_r_rate: 0, disk_w_rate: 0, probes: '{}', disks: '[]',
    process_count: 0, interval: 0,
  });
});

test('S7 小时聚合三方一致：schema 标记 ↔ metrics_hour 列 ↔ FOLD_HOUR_SQL', (t) => {
  const db = openDb(t);
  runMigrations(db);
  const hourCols = db.prepare('PRAGMA table_info(metrics_hour)').all().map((r) => r.name);
  const reserved = new Set(['agent_id', 'hour_ts', 'n']);

  const expected = [];
  for (const c of schema.COLUMNS) {
    if (!c.hour) continue;
    if (c.hour.avg) expected.push(`${c.name}_avg`);
    if (c.hour.max) expected.push(`${c.name}_max`);
    if (c.hour.last) expected.push(c.name);
    if (c.hour.special) expected.push(c.hour.special);
  }
  assert.deepStrictEqual([...hourCols.filter((n) => !reserved.has(n))].sort(), expected.sort());

  for (const c of schema.COLUMNS) {
    if (!c.hour) continue;
    if (c.hour.avg) assert.match(ROLLUP_SRC, new RegExp(`AVG\\(${c.name}\\)`), `FOLD 缺 AVG(${c.name})`);
    if (c.hour.max) assert.match(ROLLUP_SRC, new RegExp(`MAX\\(${c.name}\\)`), `FOLD 缺 MAX(${c.name})`);
    if (c.hour.last) assert.match(ROLLUP_SRC, new RegExp(`l\\.${c.name}`), `FOLD 缺末值 ${c.name}`);
  }
  assert.match(ROLLUP_SRC, /probes_hour/, 'FOLD 缺 probes_hour 写入');
});
