'use strict';
// ============================================================
// 数据库结构守护（db.js 拆分前的前置基线）
//
// db.js 里 schema DDL、19 条迁移（17 条独立 + 2 条 for-of 循环模板）与查询函数混在
// 一个文件里，拆分时最容易出错的不是搬函数，而是**迁移顺序/列补齐**——一旦顺序变了，
// 老库升级会缺列或 ALTER 失败，而现有测试大多只跑新库，发现不了。
//
// 本文件守三件事：
//   1. 新库初始化后表与迁移列齐全；
//   2. 缺列的老库再次打开时能被迁移补齐（真实执行迁移路径）；
//   3. 只读接口在空库上可调用（拆分后导出不能少）。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-schema-'));
const DB_PATH = path.join(TMP, 'monitor.db');
const DB_SRC = path.join(__dirname, '..', 'src', 'db.js');
// 探测脚本落在 /tmp，无法按目录解析 node_modules，这里解析成绝对路径注入。
const BSQ = require.resolve('better-sqlite3');

function runChild(source) {
  const file = path.join(TMP, `probe-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, source);
  const r = spawnSync(process.execPath, [file], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000,
  });
  return r;
}

function out(r) {
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT:'));
  assert.ok(line, `子进程未输出。stdout=${r.stdout}\nstderr=${r.stderr}`);
  return JSON.parse(line.slice(4));
}

test('新库：19 张业务表齐全', () => {
  const r = runChild(`
process.env.DB_PATH = ${JSON.stringify(DB_PATH)};
const db = require(${JSON.stringify(DB_SRC)});
const D = require(${JSON.stringify(BSQ)});
const c = new D(db.DB_PATH, { readonly: true });
const tables = c.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
c.close();
process.stdout.write('OUT:' + JSON.stringify(tables) + '\\n');
`);
  assert.strictEqual(r.status, 0, r.stderr);
  const tables = out(r);
  const expected = [
    'agents', 'metrics', 'metrics_hour', 'alert_state', 'alert_overrides', 'online_sessions',
    'alert_group_overrides', 'notify_channels', 'notify_groups', 'notify_group_channels',
    'api_tokens', 'theme_market_sources', 'agent_artifacts', 'agent_distributions',
    'sessions', 'traffic_state', 'admin_config', 'ai_reports', 'ai_node_reports',
    'audit_logs',
  ];
  for (const t of expected) {
    assert.ok(tables.includes(t), `缺少表 ${t}（实际 ${tables.join(',')}）`);
  }
});

test('新库：agents / metrics / ai_reports 的迁移列均已补齐', () => {
  const r = runChild(`
process.env.DB_PATH = ${JSON.stringify(DB_PATH)};
const db = require(${JSON.stringify(DB_SRC)});
const D = require(${JSON.stringify(BSQ)});
const c = new D(db.DB_PATH, { readonly: true });
const cols = (t) => c.prepare('PRAGMA table_info(' + t + ')').all().map((x) => x.name);
const result = { agents: cols('agents'), metrics: cols('metrics'), ai_reports: cols('ai_reports') };
c.close();
process.stdout.write('OUT:' + JSON.stringify(result) + '\\n');
`);
  assert.strictEqual(r.status, 0, r.stderr);
  const { agents, metrics, ai_reports } = out(r);

  for (const col of [
    'grp', 'country', 'probe_targets', 'price', 'billing_cycle', 'currency', 'auto_renewal',
    'version', 'cores', 'pending', 'build_sha', 'build_time', 'agent_platform', 'build_tag',
    'month_rotate', 'deleted_at',
  ]) {
    assert.ok(agents.includes(col), `agents 缺迁移列 ${col}`);
  }
  for (const col of [
    'swap_used', 'swap_total', 'swap_pct', 'probes', 'disk_r_rate', 'disk_w_rate', 'disks',
    'process_count', 'interval',
  ]) {
    assert.ok(metrics.includes(col), `metrics 缺迁移列 ${col}`);
  }
  for (const col of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'duration_ms', 'degraded']) {
    assert.ok(ai_reports.includes(col), `ai_reports 缺迁移列 ${col}`);
  }
});

test('老库升级：缺列的表在再次打开时被迁移补齐', () => {
  const legacy = path.join(TMP, 'legacy.db');
  // 第一步：用当前代码建库，然后删掉两个迁移列，模拟旧版本库
  const drop = runChild(`
process.env.DB_PATH = ${JSON.stringify(legacy)};
const db = require(${JSON.stringify(DB_SRC)});
const D = require(${JSON.stringify(BSQ)});
const c = new D(db.DB_PATH);
c.exec('ALTER TABLE agents DROP COLUMN build_tag');
c.exec('ALTER TABLE metrics DROP COLUMN process_count');
const left = {
  agents: c.prepare('PRAGMA table_info(agents)').all().map((x) => x.name),
  metrics: c.prepare('PRAGMA table_info(metrics)').all().map((x) => x.name),
};
c.close();
process.stdout.write('OUT:' + JSON.stringify(left) + '\\n');
`);
  assert.strictEqual(drop.status, 0, drop.stderr);
  const dropped = out(drop);
  assert.ok(!dropped.agents.includes('build_tag'), '前置条件：build_tag 已删除');
  assert.ok(!dropped.metrics.includes('process_count'), '前置条件：process_count 已删除');

  // 第二步：重新打开（触发 db.js 的迁移），应当补回
  const reopen = runChild(`
process.env.DB_PATH = ${JSON.stringify(legacy)};
const db = require(${JSON.stringify(DB_SRC)});
const D = require(${JSON.stringify(BSQ)});
const c = new D(db.DB_PATH, { readonly: true });
const cols = (t) => c.prepare('PRAGMA table_info(' + t + ')').all().map((x) => x.name);
const result = { agents: cols('agents'), metrics: cols('metrics') };
c.close();
process.stdout.write('OUT:' + JSON.stringify(result) + '\\n');
`);
  assert.strictEqual(reopen.status, 0, reopen.stderr);
  const after = out(reopen);
  assert.ok(after.agents.includes('build_tag'), '迁移应补回 agents.build_tag');
  assert.ok(after.metrics.includes('process_count'), '迁移应补回 metrics.process_count');
});

test('只读接口冒烟：拆分后这些导出必须仍在且可在空库调用', () => {
  const r = runChild(`
process.env.DB_PATH = ${JSON.stringify(path.join(TMP, 'readonly.db'))};
const db = require(${JSON.stringify(DB_SRC)});
const result = {
  agents: db.getAgents().length,
  monitored: db.getMonitoredAgents().length,
  latest: db.getLatestMetric('nope'),
  config: db.getConfig('missing'),
  notifyChannels: db.listNotifyChannels().length,
  apiTokens: db.listApiTokens().length,
  sessions: db.listSessions().length,
  aiReports: db.listAiReports(1, 0).length,
  audit: db.getAuditLogs(1, 0).length,
  watermark: db.getMetricsWatermark(),
  thresholds: typeof db.resolveAlertThresholds(),
  ui: typeof db.getUiSettings(),
};
process.stdout.write('OUT:' + JSON.stringify(result) + '\\n');
`);
  assert.strictEqual(r.status, 0, r.stderr);
  const res = out(r);
  assert.strictEqual(res.agents, 0);
  assert.strictEqual(res.monitored, 0);
  assert.ok(res.latest == null, '空库无指标时应为 null/undefined');
  assert.ok(res.config == null, '缺失配置键应为 null/undefined');
  // notify_channels 初始化会预置内置渠道（mail/telegram），只断言可调用与类型
  assert.ok(res.notifyChannels >= 0);
  assert.strictEqual(res.apiTokens, 0);
  assert.strictEqual(res.sessions, 0);
  assert.strictEqual(res.aiReports, 0);
  assert.strictEqual(res.audit, 0);
  assert.strictEqual(res.thresholds, 'object');
  assert.strictEqual(res.ui, 'object');
});

test('清理临时目录', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});
