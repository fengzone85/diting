'use strict';
// ============================================================
// 迁移版本化守护（B 批）
//
// db.js 的内联 ALTER 块已拆到 src/migrations/，本文件直接测 runner，
// 不 require db.js —— 避免 DB_PATH 环境串扰，也不依赖服务端其它模块。
// 覆盖：空库收敛、重复执行幂等、v0 老库补列与默认值、新旧库 schema 一致性、
//       失败回滚、源码闸门（db.js 不得再有 ALTER TABLE）、版本契约。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { MIGRATIONS, runMigrations } = require('../src/migrations');

const MIG_DIR = path.join(__dirname, '..', 'src', 'migrations');
const SRC_DIR = path.join(__dirname, '..', 'src');
const DB_SRC = path.join(SRC_DIR, 'db.js');

// 每张表一条：迁移完成后必须齐全的列（合计 35 列，对应 22 条历史 ALTER）
const EXPECTED_COLS = {
  metrics: [
    'temp', 'swap_used', 'swap_total', 'swap_pct', 'probes', 'disk_r_rate', 'disk_w_rate',
    'disks', 'process_count', 'interval',
  ],
  agents: [
    'grp', 'country', 'probe_targets', 'price', 'billing_cycle', 'currency', 'auto_renewal',
    'version', 'cores', 'pending', 'build_sha', 'build_time', 'agent_platform', 'build_tag',
    'hw_profile', 'month_rotate', 'deleted_at',
  ],
  sessions: ['expires_at', 'remember'],
  traffic_state: ['epoch'],
  ai_reports: ['prompt_tokens', 'completion_tokens', 'total_tokens', 'duration_ms', 'degraded'],
};

function openDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, 'monitor.db'));
  t.after(() => { try { db.close(); } catch { /* 已关闭 */ } });
  return db;
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name);
}

function cols(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function walkJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJs(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('M1 空库：依次应用 1–6，21 张业务表与版本行齐全', (t) => {
  const db = openDb(t);
  assert.deepStrictEqual(runMigrations(db, 1700000000000), [1, 2, 3, 4, 5, 6]);

  const rows = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
  assert.deepStrictEqual(rows.map((r) => r.version), [1, 2, 3, 4, 5, 6]);
  assert.ok(rows.every((r) => r.applied_at === 1700000000000), 'applied_at 应统一取传入的 now');
  assert.ok(rows.every((r) => typeof r.name === 'string' && r.name.length > 0), 'name 不可为空');

  const tables = tableNames(db);
  const expected = [
    'agents', 'metrics', 'metrics_hour', 'alert_state', 'alert_overrides', 'online_sessions',
    'alert_group_overrides', 'notify_channels', 'notify_groups', 'notify_group_channels',
    'api_tokens', 'theme_market_sources', 'agent_artifacts', 'agent_distributions',
    'sessions', 'traffic_state', 'admin_config', 'ai_reports', 'ai_node_reports',
    'audit_logs', 'recovery_codes',
  ];
  for (const table of expected) assert.ok(tables.includes(table), `缺少表 ${table}`);
  assert.strictEqual(expected.length, 21);

  for (const [table, list] of Object.entries(EXPECTED_COLS)) {
    const have = cols(db, table);
    for (const col of list) assert.ok(have.includes(col), `${table} 缺列 ${col}`);
  }
});

test('M2 重复执行：第二次返回空数组，版本行不变', (t) => {
  const db = openDb(t);
  runMigrations(db, 1700000000000);
  const before = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();

  assert.deepStrictEqual(runMigrations(db, 1800000000000), []);
  const after = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
  assert.deepStrictEqual(after, before, '重复执行不应改动任何版本行');
});

test('M3 v0 老库：只跑过 001 的库能补齐 35 列，默认值与存量数据不变', (t) => {
  const db = openDb(t);
  // 构造「老版本库」：只有基线，且迁移记录里只有 001
  MIGRATIONS[0].up(db);
  db.exec(`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
);
INSERT INTO schema_migrations VALUES (1, 'baseline', 1);
INSERT INTO agents (id, name, token_hash, created_at) VALUES ('a1', '老节点', 'h', 1);
INSERT INTO metrics (agent_id, ts, cpu) VALUES ('a1', 1, 12.5);
INSERT INTO sessions (id, created_at, last_seen) VALUES ('s1', 1, 1);
`);

  assert.deepStrictEqual(runMigrations(db, 2000), [2, 3, 4, 5, 6]);

  for (const [table, list] of Object.entries(EXPECTED_COLS)) {
    const have = cols(db, table);
    for (const col of list) assert.ok(have.includes(col), `${table} 缺列 ${col}`);
  }

  const agent = db.prepare(`SELECT name, grp, price, billing_cycle, currency, auto_renewal,
    pending, cores, month_rotate, deleted_at FROM agents WHERE id='a1'`).get();
  assert.strictEqual(agent.name, '老节点', '存量数据不应被改动');
  assert.strictEqual(agent.grp, '');
  assert.strictEqual(agent.price, 0);
  assert.strictEqual(agent.billing_cycle, 30);
  assert.strictEqual(agent.currency, '¥');
  assert.strictEqual(agent.auto_renewal, 1);
  assert.strictEqual(agent.pending, 0);
  assert.strictEqual(agent.cores, 0);
  assert.strictEqual(agent.month_rotate, null, 'month_rotate 三态：NULL = 未设置');
  assert.strictEqual(agent.deleted_at, null);

  const session = db.prepare("SELECT expires_at, remember FROM sessions WHERE id='s1'").get();
  assert.strictEqual(session.expires_at, null, '存量会话保持旧口径（NULL）');
  assert.strictEqual(session.remember, 0);

  const metric = db.prepare("SELECT cpu, process_count, interval FROM metrics WHERE agent_id='a1'").get();
  assert.strictEqual(metric.cpu, 12.5);
  assert.strictEqual(metric.process_count, 0);
  assert.strictEqual(metric.interval, 0);

  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 1);
});

test('M4 收敛性：空库迁移与 v0 老库迁移后的 schema 逐列一致', (t) => {
  const fresh = openDb(t);
  runMigrations(fresh, 1);

  const legacy = openDb(t);
  MIGRATIONS[0].up(legacy);
  legacy.exec(`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
);
INSERT INTO schema_migrations VALUES (1, 'baseline', 1);
`);
  runMigrations(legacy, 1);

  const tables = tableNames(fresh).filter((x) => x !== 'schema_migrations').sort();
  assert.deepStrictEqual(tableNames(legacy).filter((x) => x !== 'schema_migrations').sort(), tables);
  for (const table of tables) {
    const pick = (db) => db.prepare(`PRAGMA table_info(${table})`).all()
      .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }));
    assert.deepStrictEqual(pick(legacy), pick(fresh), `表 ${table} 的列定义与空库迁移结果不一致`);
  }
});

test('M5 迁移失败：整条迁移回滚，不写版本行', (t) => {
  const db = openDb(t);
  const boom = {
    version: 99,
    name: 'boom',
    up(d) {
      d.exec('CREATE TABLE boom_probe (id INTEGER)');
      throw new Error('注入失败');
    },
  };
  MIGRATIONS.push(boom);
  try {
    assert.throws(() => runMigrations(db, 3000), /注入失败/);
  } finally {
    MIGRATIONS.pop();
  }

  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  assert.deepStrictEqual(versions, [1, 2, 3, 4, 5, 6], '失败迁移不应留下版本行，已成功版本应保留');
  assert.ok(!tableNames(db).includes('boom_probe'), '失败迁移里的 DDL 必须随事务回滚');
});

test('M6 源码闸门：src/ 下只有 migrations/ 允许出现 ALTER TABLE', () => {
  const text = fs.readFileSync(DB_SRC, 'utf8');
  assert.ok(!text.includes('ALTER TABLE'), 'db.js 不应再包含内联 ALTER TABLE');

  const offenders = walkJs(SRC_DIR)
    .filter((f) => !f.startsWith(MIG_DIR + path.sep))
    .filter((f) => fs.readFileSync(f, 'utf8').includes('ALTER TABLE'))
    .map((f) => path.relative(SRC_DIR, f));
  assert.deepStrictEqual(offenders, [], `以下文件仍含 ALTER TABLE：${offenders.join(', ')}`);
});

test('M7 版本契约：版本唯一、严格升序，且与文件名数字前缀一致', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.strictEqual(new Set(versions).size, versions.length, '版本号不可重复');
  for (let i = 1; i < versions.length; i++) {
    assert.ok(versions[i] > versions[i - 1], `版本号必须严格升序：${versions.join(',')}`);
  }

  const files = fs.readdirSync(MIG_DIR)
    .filter((f) => /^\d{3}-.+\.js$/.test(f))
    .sort();
  assert.deepStrictEqual(
    versions,
    files.map((f) => Number(f.slice(0, 3))),
    'MIGRATIONS 的版本序列必须与迁移文件名的数字前缀一致',
  );
  for (const m of MIGRATIONS) assert.ok(typeof m.name === 'string' && m.name.length > 0, '每个迁移必须有 name');
});
