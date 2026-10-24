const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
// 审查 C4：重聚合 SQL 与 db 句柄解耦后放这里——主线程（db.js 委派）与
// worker 线程（dbworker.js 只读连接）共用同一份实现，避免两条路径语义分叉。
const heavyQueries = require('./heavy-queries');
const traffic = require('./traffic');

// 数据库默认落盘位置：容器内若挂载了持久卷 /data（docker-compose 的 server-data），
// 则写入 /data/monitor.db，确保重建容器后数据仍在；否则回退到本地 server/data（开发/裸跑）。
const DB_PATH = process.env.DB_PATH || (() => {
  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) return '/data/monitor.db';
  } catch (e) {}
  return path.join(__dirname, '..', 'data', 'monitor.db');
})();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// 负载曲线列集（不含 probes / disks 大字段）——统一定义在 heavy-queries.js，
// 主线程与 worker 共用（process_count：2026-10-12 新增，Komari 兼容层消费）。
const LOAD_COLS = heavyQueries.LOAD_COLS;

const db = new Database(DB_PATH);
// 收紧数据库文件权限：仅属主可读写（默认 umask 常为 644，其他用户可读）。
// 库内虽无指纹指标，但含全部监控数据，按最小权限原则限制暴露面。
try { fs.chmodSync(DB_PATH, 0o600); } catch (e) { /* 某些挂载文件系统不支持 chmod，忽略 */ }
// 增量回收（对齐方案附录 D.1）：保留策略删掉旧指标后，把空闲页归还文件系统。
// auto_vacuum 是写在库头里的持久标志：从 NONE 改成 INCREMENTAL 需要一次完整 VACUUM 才生效，
// 所以对存量库这里只是"置位"，真正回收发生在 `diting.sh --db-vacuum` 之后。
// 实测教训：本机库曾 96.4% 是 freelist（1510MB 里只有 54MB 有效数据）。
try { db.pragma('auto_vacuum = INCREMENTAL'); } catch (e) {
  console.warn('[db] auto_vacuum 设置失败（不影响读写）:', e.message);
}
// NOTE: intentionally NOT using WAL mode. WAL requires a -shm shared-memory file
// which fails on some mounted/network filesystems (SQLITE_IOERR_SHMOPEN).
// This app is single-writer, so the default rollback-journal mode is sufficient.

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  merchant        TEXT DEFAULT '',
  note            TEXT DEFAULT '',
  expire_at       TEXT DEFAULT '',
  monthly_quota_gb REAL DEFAULT 0,
  os              TEXT DEFAULT '',
  hostname        TEXT DEFAULT '',
  created_at      INTEGER NOT NULL,
  last_seen       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS metrics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  cpu           REAL,
  mem_used      INTEGER,
  mem_total     INTEGER,
  mem_pct       REAL,
  disk_used     INTEGER,
  disk_total    INTEGER,
  disk_pct      REAL,
  load1         REAL,
  load5         REAL,
  load15        REAL,
  net_rx_rate   REAL,
  net_tx_rate   REAL,
  net_rx_month  INTEGER,
  net_tx_month  INTEGER,
  uptime        REAL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_metrics_agent_ts ON metrics(agent_id, ts);
-- 全量 sparklines 查询（WHERE ts>=? 无 agent_id 条件）需要单列 ts 索引，避免 7d 窗口全表扫描
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);

CREATE TABLE IF NOT EXISTS alert_state (
  agent_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  last_sent  INTEGER NOT NULL,
  PRIMARY KEY(agent_id, type)
);

-- 告警规则覆盖（S1/F1）：NULL = 继承上层（分组 > 全局）。
-- 刻意不声明 FOREIGN KEY：本库未启用 PRAGMA foreign_keys（better-sqlite3 默认关），
-- 级联不会执行；删除 agent 时由 deleteAgent() 同事务显式清理本表。
CREATE TABLE IF NOT EXISTS alert_overrides (
  agent_id    TEXT PRIMARY KEY,
  offline_sec INTEGER,
  cpu_pct     REAL,
  mem_pct     REAL,
  disk_pct    REAL,
  temp_c      REAL,
  cooldown    INTEGER,
  muted       INTEGER DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- 分组级覆盖：grp 为 agents.grp 的取值（'' = 未分组/默认组）。
CREATE TABLE IF NOT EXISTS alert_group_overrides (
  grp         TEXT PRIMARY KEY,
  offline_sec INTEGER,
  cpu_pct     REAL,
  mem_pct     REAL,
  disk_pct    REAL,
  temp_c      REAL,
  cooldown    INTEGER,
  muted       INTEGER DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- S1/F2 通知渠道：type ∈ mail|telegram|webhook。
-- 内置 mail/telegram 的凭据仍存 admin_config.notify_config（单一事实源，避免双写漂移），
-- 本表只承载启用开关与展示名；webhook 的 URL/方法/头/模板存 config JSON。
CREATE TABLE IF NOT EXISTS notify_channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  enabled    INTEGER DEFAULT 1,
  config     TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(type, name)
);

-- S1/F2 通知组：events 为 JSON 数组（['*'] = 全部事件）；enabled 关闭后整组不投递。
CREATE TABLE IF NOT EXISTS notify_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  events     TEXT NOT NULL DEFAULT '[]',
  enabled    INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 组与渠道多对多。刻意不声明外键（本库未启用 foreign_keys），删除时由函数显式清理。
CREATE TABLE IF NOT EXISTS notify_group_channels (
  group_id   INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  PRIMARY KEY (group_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_group_channels_channel ON notify_group_channels(channel_id);

-- S2/F5 API Token：明文只在创建时返回一次，库中仅存 SHA-256。
-- agent_ids：JSON 数组；'[]' = 全部节点（与 scope 组合收窄权限）。
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'readonly',
  agent_ids    TEXT NOT NULL DEFAULT '[]',
  expires_at   INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  last_used_ip TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL DEFAULT '',
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

-- S5/F10 主题市场源：管理员可增删的 catalog 地址（config.Set("theme", ...) 的同构物）。
-- url 唯一保证幂等：同一地址重复添加不会产生第二条。enabled=0 的源不参与聚合。
CREATE TABLE IF NOT EXISTS theme_market_sources (
  id         TEXT PRIMARY KEY,            -- 'src_' + 12 hex
  name       TEXT NOT NULL,
  url        TEXT NOT NULL UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- S2/F6 登录会话：cookie 内只带 sid，吊销状态以本表为准；
-- session_revoked_before 水位线保留为全局 kill switch。
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  admin      TEXT NOT NULL DEFAULT 'admin',
  ip         TEXT NOT NULL DEFAULT '',
  ua         TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);

-- P1 流量口径累加器：小表，避免给 metrics 增加原始计数器列。
CREATE TABLE IF NOT EXISTS traffic_state (
  agent_id    TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  cycle_key   TEXT,
  cycle_start INTEGER,
  used_rx     INTEGER CHECK (used_rx BETWEEN 0 AND 9007199254740991),
  used_tx     INTEGER CHECK (used_tx BETWEEN 0 AND 9007199254740991),
  last_rx     INTEGER CHECK (last_rx BETWEEN 0 AND 9007199254740991),
  last_tx     INTEGER CHECK (last_tx BETWEEN 0 AND 9007199254740991),
  last_ts     INTEGER,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS admin_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ai_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  period        TEXT,
  risk_level    TEXT,
  summary       TEXT,
  suggestion    TEXT,
  report_json   TEXT,
  prompt_version TEXT,
  created_at    INTEGER NOT NULL,
  prompt_tokens     INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens      INTEGER DEFAULT 0,
  duration_ms       INTEGER DEFAULT 0,
  degraded          INTEGER DEFAULT 0
);

-- 单节点按需分析的历史（§8 T17）。每次「真实调用模型」成功后落一条，
-- 供弹窗展示「上次分析 X 分钟前」与历史列表；缓存命中不重复落库（避免历史被同一次结果刷屏）。
-- report_json 存该次返回的 payload 子集（analysis/usage），列表查询刻意不取该列。
CREATE TABLE IF NOT EXISTS ai_node_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT NOT NULL,
  period_hours  INTEGER NOT NULL,
  status        TEXT,
  risk_level    TEXT,
  report_json   TEXT,
  prompt_version TEXT,
  created_at    INTEGER NOT NULL,
  prompt_tokens     INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens      INTEGER DEFAULT 0,
  duration_ms       INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_node_reports_agent ON ai_node_reports(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_reports_created ON ai_reports(created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  admin     TEXT NOT NULL,
  ip        TEXT DEFAULT '',
  action    TEXT NOT NULL,
  detail    TEXT DEFAULT '',
  via       TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);
`);

// ---- schema migration: add temp / swap columns if missing (existing DBs) ----
// Column names and types below are hardcoded constants (not user input) — no injection risk.
{
  const existing = new Set(db.prepare('PRAGMA table_info(metrics)').all().map((r) => r.name));
  const cols = [
    ['temp', 'REAL'],
    ['swap_used', 'INTEGER'],
    ['swap_total', 'INTEGER'],
    ['swap_pct', 'REAL'],
    ['probes', 'TEXT'],
    ['disk_r_rate', 'REAL'],
    ['disk_w_rate', 'REAL'],
    ['disks', 'TEXT'],
    // 进程总数（聚合计数，非指纹；0 = 未采集/老 agent 不带该字段）
    ['process_count', 'INTEGER DEFAULT 0'],
    // 审查 C-1/E2：受控端上报的实际上报间隔（秒），0 = 未上报/老 agent
    ['interval', 'INTEGER DEFAULT 0'],
  ];
  for (const [col, type] of cols) {
    if (!existing.has(col)) db.exec(`ALTER TABLE metrics ADD COLUMN ${col} ${type};`);
  }
}

// schema migration: agents 增加分组字段（避免使用 SQL 关键字 group，列名用 grp）
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('grp')) db.exec("ALTER TABLE agents ADD COLUMN grp TEXT DEFAULT ''");
}
// schema migration: agents 增加国家字段（受控端国旗，存 ISO 3166-1 alpha-2 代码，如 CN/US/JP）
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('country')) db.exec("ALTER TABLE agents ADD COLUMN country TEXT DEFAULT ''");
}
// schema migration: agents 增加探测目标(网络质量自测 DNS)列，服务端可配置、按受控端独立存储
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('probe_targets')) db.exec("ALTER TABLE agents ADD COLUMN probe_targets TEXT DEFAULT ''");
}
// schema migration: agents 增加账单字段（价格 / 计费周期 / 货币 / 自动续费）
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('price')) db.exec("ALTER TABLE agents ADD COLUMN price REAL DEFAULT 0");
  if (!existing.has('billing_cycle')) db.exec("ALTER TABLE agents ADD COLUMN billing_cycle INTEGER DEFAULT 30");
  if (!existing.has('currency')) db.exec("ALTER TABLE agents ADD COLUMN currency TEXT DEFAULT '¥'");
  if (!existing.has('auto_renewal')) db.exec("ALTER TABLE agents ADD COLUMN auto_renewal INTEGER DEFAULT 1");
  // 受控端版本：从上报请求的 User-Agent（diting-agent-go/x.y.z / diting-agent/x.y）解析而来
  if (!existing.has('version')) db.exec("ALTER TABLE agents ADD COLUMN version TEXT DEFAULT ''");
}
// schema migration: agents 增加 CPU 核数列（受控端上报的静态硬件属性，§9 T18）。
// 语义：0 = 未上报/未知（老 agent 不带该字段）——**不可当作 1 用**，摘要侧会标 cores_unknown。
// 放 agents 表而不是 metrics 表：静态属性，避免给 2200 万行的 metrics 加列。
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('cores')) db.exec('ALTER TABLE agents ADD COLUMN cores INTEGER DEFAULT 0');
}
// schema migration: agents 增加 pending 列（审查 G4：自助注册的 agent 默认待管理员确认）。
// 语义：0 = 已确认（ADD COLUMN 默认值即 0，所有历史 agent 不受影响）；1 = 待确认。
// 待确认期间禁止上报（auth.js agentAuth 拒绝），且不进入看板/公开页/告警/AI 统计
// （getMonitoredAgents 过滤）——防 SETUP_TOKEN 泄露后被批量注册污染数据与看板。
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('pending')) db.exec('ALTER TABLE agents ADD COLUMN pending INTEGER DEFAULT 0');
}
// P1: agents 增加流量重置日列。三态 NULL=未设置（采纳 agent 上报）/0=累计/1–31=重置日；不给默认值。
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('month_rotate')) db.exec('ALTER TABLE agents ADD COLUMN month_rotate INTEGER');
}
// F11（2026-10-24）：agents 增加软删列。删除 = 写 deleted_at（节点立即从全部读路径消失），
// 7 天缓冲期内可由「最近删除」恢复；到期由 purgeDeletedAgents() 物理删除
//（此时 FK CASCADE 才带走 metrics / traffic_state）。NULL = 未删除。
{
  const existing = new Set(db.prepare('PRAGMA table_info(agents)').all().map((r) => r.name));
  if (!existing.has('deleted_at')) db.exec('ALTER TABLE agents ADD COLUMN deleted_at INTEGER');
}

// schema migration: ai_reports 增加 token 用量 / 耗时 / 降级标记列（老库 ADD COLUMN；列名硬编码常量）
{
  const existing = new Set(db.prepare('PRAGMA table_info(ai_reports)').all().map((r) => r.name));
  const cols = [
    ['prompt_tokens', 'INTEGER DEFAULT 0'],
    ['completion_tokens', 'INTEGER DEFAULT 0'],
    ['total_tokens', 'INTEGER DEFAULT 0'],
    ['duration_ms', 'INTEGER DEFAULT 0'],
    ['degraded', 'INTEGER DEFAULT 0'],
  ];
  for (const [col, type] of cols) {
    if (!existing.has(col)) db.exec(`ALTER TABLE ai_reports ADD COLUMN ${col} ${type};`);
  }
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const genToken = () => crypto.randomBytes(24).toString('hex');
const genId = () => 'agt_' + crypto.randomBytes(6).toString('hex');

const stmts = {
  // F11：读路径统一排除软删节点；恢复/删除判定用 getAgentIncludingDeleted。
  getAgent: db.prepare('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL'),
  getAgents: db.prepare('SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY created_at DESC'),
  getDeletedAgents: db.prepare('SELECT * FROM agents WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'),
  getAgentIncludingDeleted: db.prepare('SELECT * FROM agents WHERE id = ?'),
  insertAgent: db.prepare(`INSERT INTO agents
    (id, name, token_hash, merchant, note, expire_at, monthly_quota_gb, price, billing_cycle, currency, auto_renewal, grp, country, probe_targets, pending, created_at, last_seen)
    VALUES (@id, @name, @token_hash, @merchant, @note, @expire_at, @monthly_quota_gb, @price, @billing_cycle, @currency, @auto_renewal, @grp, @country, @probe_targets, @pending, @created_at, 0)`),
  updateAgent: db.prepare(`UPDATE agents SET
    name=@name, merchant=@merchant, note=@note, expire_at=@expire_at, monthly_quota_gb=@monthly_quota_gb,
    month_rotate=@month_rotate,
    price=@price, billing_cycle=@billing_cycle, currency=@currency, auto_renewal=@auto_renewal,
    grp=@grp, country=@country, probe_targets=@probe_targets
    WHERE id=@id`),
  upsertTrafficState: db.prepare(`INSERT OR REPLACE INTO traffic_state
    (agent_id, cycle_key, cycle_start, used_rx, used_tx, last_rx, last_tx, last_ts, updated_at)
    VALUES (@agent_id, @cycle_key, @cycle_start, @used_rx, @used_tx, @last_rx, @last_tx, @last_ts, @updated_at)`),
  allTrafficState: db.prepare('SELECT * FROM traffic_state'),
  // F11：软删（一条 UPDATE，7 天缓冲）；物理删除仅由 purgeDeletedAgents 使用。
  softDeleteAgent: db.prepare('UPDATE agents SET deleted_at=? WHERE id=? AND deleted_at IS NULL'),
  restoreAgentRow: db.prepare('UPDATE agents SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL'),
  hardDeleteAgent: db.prepare('DELETE FROM agents WHERE id = ?'),
  expiredDeletedAgents: db.prepare('SELECT id FROM agents WHERE deleted_at IS NOT NULL AND deleted_at < ?'),
  purgeAlertState: db.prepare('DELETE FROM alert_state WHERE agent_id=?'),
  purgeAlertOverride: db.prepare('DELETE FROM alert_overrides WHERE agent_id=?'),
  // 审查 G4：批准自助注册的待确认 agent（pending 1→0）
  approveAgent: db.prepare('UPDATE agents SET pending=0 WHERE id=?'),
  // 审查 E1：最近 N 条指标（旧→新），供告警"连续 N 个采样超限"判定
  recentMetrics: db.prepare('SELECT * FROM metrics WHERE agent_id=? ORDER BY ts DESC LIMIT ?'),
  // version 用 COALESCE(NULLIF(...)) 保留旧值：老 agent 或无法解析 UA 时不覆盖已知版本
  touch: db.prepare("UPDATE agents SET last_seen=?, os=?, hostname=?, version=COALESCE(NULLIF(?,''), version) WHERE id=?"),
  // 仅当核数变化时才写（静态属性，避免每次上报都触发写事务）；cores<=0 不写入
  setAgentCores: db.prepare('UPDATE agents SET cores=? WHERE id=? AND cores<>?'),
  insertMetric: db.prepare(`INSERT INTO metrics
    (agent_id, ts, cpu, mem_used, mem_total, mem_pct, disk_used, disk_total, disk_pct,
     load1, load5, load15, net_rx_rate, net_tx_rate, net_rx_month, net_tx_month, uptime,
     temp, swap_used, swap_total, swap_pct, disk_r_rate, disk_w_rate, probes, disks, process_count, interval)
    VALUES (@agent_id, @ts, @cpu, @mem_used, @mem_total, @mem_pct, @disk_used, @disk_total, @disk_pct,
     @load1, @load5, @load15, @net_rx_rate, @net_tx_rate, @net_rx_month, @net_tx_month, @uptime,
     @temp, @swap_used, @swap_total, @swap_pct, @disk_r_rate, @disk_w_rate, @probes, @disks, @process_count, @interval)`),
  // 窗口内实际有数据的节点数（用于历史接口的每节点点数分摊）
  countActiveAgents: db.prepare('SELECT COUNT(DISTINCT agent_id) AS c FROM metrics WHERE ts>=?'),
  latestMetric: db.prepare('SELECT * FROM metrics WHERE agent_id=? ORDER BY ts DESC LIMIT 1'),
  // metricsRange（SELECT * 单节点全量）已于 2026-09-13 删除：
  // 唯一调用方 /api/agents/:id/metrics 已改走 metricsRangeSampled（见 getMetricsSampled）。
  // 该路由此前会全量拉取（30d 约 12.9 万行 + probes/disks 大 JSON），apdex 极差。
  // 单节点全字段 SQL 层采样（兼容层 /records/load 与 /api/v1 历史专用）。
  // 此前这些接口走 metricsRange 全量拉取（100 台 × 720h 可达百万行）后在 JS 层 sort/slice，
  // 单次请求数百万次行物化 + 大数组排序，是典型的 DoS 放大器。
  // 与 metricsProbesOne 同构：窗口函数均匀抽样，保留首尾点；step 绑定必须是整型（内层 CAST）。
  metricsRangeSampled: (agentId, sinceTs, maxPoints) => {
    const step = Math.max(1, Math.floor(Number(maxPoints) || 1));
    return db.prepare(`
      WITH numbered AS (
        SELECT *,
               ROW_NUMBER() OVER (ORDER BY ts ASC) AS rn,
               COUNT(*) OVER () AS cnt
        FROM metrics WHERE agent_id=@agentId AND ts>=@since
      )
      SELECT * FROM numbered
      WHERE rn = 1 OR rn = cnt OR rn % MAX(1, CAST(cnt/CAST(@step AS INTEGER) AS INTEGER)) = 0
      ORDER BY ts ASC`).all({ agentId, since: sinceTs, step });
  },
  // 负载曲线专用列集：刻意不含 probes / disks。
  // 这两列是 JSON 文本（probes 常 100B+、disks 可达数百 B），在窗口函数 CTE 里
  // 会被整行物化——720h 单节点 13.5 万行 × 大字段 ⇒ 数百 MB 临时集 + 25s 响应时间。
  // 实测：/api/records/load?hours=720 从 25.5s 降到亚秒级。
  // 审查 C4：SQL 本体移至 heavy-queries.js（主线程与 worker 线程共用）
  metricsLoadOne: (agentId, sinceTs, maxPoints) => heavyQueries.loadOne(db, agentId, sinceTs, maxPoints),
  // 跨节点版本：按「时间桶 + 取桶内最早一行」采样（每节点约 maxPoints 点）。
  // 不用窗口函数：实测 720h 全库（191 万行）窗口版 23.6s，分桶版 2.2s——
  // 窗口函数要把整段匹配行进临时 B-TREE 排序两遍（ROW_NUMBER 分区 + 最终 ORDER BY），
  // 分桶只做一次覆盖索引扫描 + 分组（同样保留首尾桶，不丢首尾点语义）。
  // 审查 C4：SQL 本体移至 heavy-queries.js（主线程与 worker 线程共用）
  metricsLoadAll: (sinceTs, maxPoints) => heavyQueries.loadAll(db, sinceTs, maxPoints),
  // probes 接口只需 ts+probes 两列；避免 SELECT * 物化全行（24 列，30d 近 9.5 万行）拖慢查询
  metricsProbes: db.prepare('SELECT ts, probes FROM metrics WHERE agent_id=? AND ts>=? ORDER BY ts ASC'),
  // 单节点探针 SQL 层采样（详情页延迟波形专用）：只返回 maxPoints 行，保留首尾点。
  // 此前全量拉 9.5 万行并逐行 JSON.parse(probes)（9.5 万次解析），是详情页"慢/有时无法显示"的
  // 另一半原因。SQL 层采样后只需解析 maxPoints 次，JS 层再做 avg 桶聚合（对 2000 点做聚合极轻）。
  // 注意：step 由绑定参数传入而非字符串内插（better-sqlite3 不允许 positional 与 named 混用，
  // 故 ts>/agent_id 一并改为 named）。内层 CAST 是必须的：绑定对象里的 number 会被绑成 REAL，
  // 导致 cnt/@step 变成浮点除法、rn % REAL 几乎永不等于 0，采样会静默退化为只返回首尾两行。
  metricsProbesOne: (agentId, sinceTs, maxPoints) => {
    const step = Math.max(1, Math.floor(Number(maxPoints) || 1));
    return db.prepare(`
      WITH numbered AS (
        SELECT ts, probes,
               ROW_NUMBER() OVER (ORDER BY ts ASC) AS rn,
               COUNT(*) OVER () AS cnt
        FROM metrics WHERE agent_id=@agentId AND ts>=@since AND probes IS NOT NULL
      )
      SELECT ts, probes
      FROM numbered
      WHERE rn = 1 OR rn = cnt OR rn % MAX(1, CAST(cnt/CAST(@step AS INTEGER) AS INTEGER)) = 0
      ORDER BY ts ASC`).all({ agentId, since: sinceTs, step });
  },
  prune: db.prepare('DELETE FROM metrics WHERE ts < ?'),
  getAlertState: db.prepare('SELECT * FROM alert_state WHERE agent_id=? AND type=?'),
  setAlertState: db.prepare('INSERT OR REPLACE INTO alert_state (agent_id, type, last_sent) VALUES (?,?,?)'),
  clearAlertState: db.prepare('DELETE FROM alert_state WHERE agent_id=? AND type=?'),
  clearAllAlertState: db.prepare('DELETE FROM alert_state WHERE agent_id=?'),
  // ---- 告警覆盖（S1/F1）----
  getAlertOverride: db.prepare('SELECT * FROM alert_overrides WHERE agent_id=?'),
  listAlertOverrides: db.prepare('SELECT * FROM alert_overrides ORDER BY agent_id'),
  deleteAlertOverride: db.prepare('DELETE FROM alert_overrides WHERE agent_id=?'),
  upsertAlertOverride: db.prepare(`INSERT INTO alert_overrides
    (agent_id, offline_sec, cpu_pct, mem_pct, disk_pct, temp_c, cooldown, muted, updated_at)
    VALUES (@agent_id, @offline_sec, @cpu_pct, @mem_pct, @disk_pct, @temp_c, @cooldown, @muted, @updated_at)
    ON CONFLICT(agent_id) DO UPDATE SET
      offline_sec=@offline_sec, cpu_pct=@cpu_pct, mem_pct=@mem_pct, disk_pct=@disk_pct,
      temp_c=@temp_c, cooldown=@cooldown, muted=@muted, updated_at=@updated_at`),
  getGroupAlertOverride: db.prepare('SELECT * FROM alert_group_overrides WHERE grp=?'),
  listGroupAlertOverrides: db.prepare('SELECT * FROM alert_group_overrides ORDER BY grp'),
  deleteGroupAlertOverride: db.prepare('DELETE FROM alert_group_overrides WHERE grp=?'),
  upsertGroupAlertOverride: db.prepare(`INSERT INTO alert_group_overrides
    (grp, offline_sec, cpu_pct, mem_pct, disk_pct, temp_c, cooldown, muted, updated_at)
    VALUES (@grp, @offline_sec, @cpu_pct, @mem_pct, @disk_pct, @temp_c, @cooldown, @muted, @updated_at)
    ON CONFLICT(grp) DO UPDATE SET
      offline_sec=@offline_sec, cpu_pct=@cpu_pct, mem_pct=@mem_pct, disk_pct=@disk_pct,
      temp_c=@temp_c, cooldown=@cooldown, muted=@muted, updated_at=@updated_at`),
  // ---- 通知渠道/通知组（S1/F2）----
  insertChannelIfAbsent: db.prepare(`INSERT OR IGNORE INTO notify_channels
    (type, name, enabled, config, created_at, updated_at) VALUES (?,?,1,'{}',?,?)`),
  insertNotifyChannel: db.prepare(`INSERT INTO notify_channels
    (type, name, enabled, config, created_at, updated_at) VALUES (@type, @name, @enabled, @config, @created_at, @updated_at)`),
  getNotifyChannel: db.prepare('SELECT * FROM notify_channels WHERE id=?'),
  listNotifyChannels: db.prepare('SELECT * FROM notify_channels ORDER BY id'),
  updateNotifyChannel: db.prepare(`UPDATE notify_channels
    SET name=@name, enabled=@enabled, config=@config, updated_at=@updated_at WHERE id=@id`),
  deleteNotifyChannel: db.prepare('DELETE FROM notify_channels WHERE id=?'),
  countNotifyGroups: db.prepare('SELECT COUNT(*) AS n FROM notify_groups'),
  insertNotifyGroup: db.prepare(`INSERT INTO notify_groups
    (name, events, enabled, created_at, updated_at) VALUES (@name, @events, @enabled, @created_at, @updated_at)`),
  getNotifyGroup: db.prepare('SELECT * FROM notify_groups WHERE id=?'),
  listNotifyGroups: db.prepare('SELECT * FROM notify_groups ORDER BY id'),
  updateNotifyGroup: db.prepare(`UPDATE notify_groups
    SET name=@name, events=@events, enabled=@enabled, updated_at=@updated_at WHERE id=@id`),
  deleteNotifyGroup: db.prepare('DELETE FROM notify_groups WHERE id=?'),
  listEnabledGroupsForEvent: db.prepare('SELECT * FROM notify_groups WHERE enabled=1'),
  bindGroupChannel: db.prepare('INSERT OR IGNORE INTO notify_group_channels (group_id, channel_id) VALUES (?,?)'),
  clearGroupChannels: db.prepare('DELETE FROM notify_group_channels WHERE group_id=?'),
  deleteGroupChannelByChannel: db.prepare('DELETE FROM notify_group_channels WHERE channel_id=?'),
  listGroupChannelIds: db.prepare('SELECT channel_id FROM notify_group_channels WHERE group_id=?'),
  listGroupChannelRows: db.prepare(`SELECT g.group_id, g.channel_id FROM notify_group_channels g
    JOIN notify_channels c ON c.id=g.channel_id WHERE c.enabled=1`),
  // ---- S2/F5 API Token ----
  insertApiToken: db.prepare(`INSERT INTO api_tokens
    (id, name, token_hash, scope, agent_ids, expires_at, created_at, created_by)
    VALUES (@id, @name, @token_hash, @scope, @agent_ids, @expires_at, @created_at, @created_by)`),
  getApiTokenByHash: db.prepare('SELECT * FROM api_tokens WHERE token_hash=?'),
  getApiTokenById: db.prepare('SELECT * FROM api_tokens WHERE id=?'),
  listApiTokens: db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC'),
  touchApiToken: db.prepare('UPDATE api_tokens SET last_used_at=?, last_used_ip=? WHERE id=?'),
  revokeApiToken: db.prepare('UPDATE api_tokens SET revoked=1 WHERE id=?'),
  // ---- S2/F6 会话 ----
  insertSession: db.prepare(`INSERT INTO sessions (id, admin, ip, ua, created_at, last_seen)
    VALUES (@id, @admin, @ip, @ua, @created_at, @last_seen)`),
  getSessionRow: db.prepare('SELECT * FROM sessions WHERE id=?'),
  listSessions: db.prepare('SELECT * FROM sessions WHERE revoked=0 ORDER BY last_seen DESC'),
  touchSession: db.prepare('UPDATE sessions SET last_seen=? WHERE id=?'),
  revokeSession: db.prepare('UPDATE sessions SET revoked=1 WHERE id=?'),
  revokeAllSessionRows: db.prepare('UPDATE sessions SET revoked=1 WHERE revoked=0'),
  // 保留指定会话的批量吊销（后台「踢出其它设备」但保留当前操作的那台）。
  // 与 revokeAllSessionRows 的区别：不设全局水位线，只按表逐行标记。
  revokeAllSessionRowsExcept: db.prepare('UPDATE sessions SET revoked=1 WHERE revoked=0 AND id<>?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE last_seen < ?'),
  resetToken: db.prepare('UPDATE agents SET token_hash=? WHERE id=?'),
  // 磁盘趋势专用：跨所有 agent 按时间桶取 disk_pct 均值。
  // 只取三列、单次扫描、无窗口函数；**必须输出 MIN(ts) AS ts** —— 若只返回桶号，
  // 调用方用 last.ts - first.ts 求跨度会得到 NaN → 趋势分析静默失效。
  // 复刻 metricsClusterAvg 的 CAST 整数地板除法：绑定 number 会被 better-sqlite3 绑成 REAL，
  // 浮点除法会让每个值自成一组。
  // 审查 C4：SQL 本体移至 heavy-queries.js（主线程与 worker 线程共用）
  metricsDiskTrendAll: (sinceTs, bucketMs) => heavyQueries.diskTrendAll(db, sinceTs, bucketMs),
  // sparklines 只需要指标列（不含 probes 大字段）：单节点 30d 由 5.3s 降到 2.3s
  metricsSparklines: db.prepare('SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate, load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total FROM metrics WHERE agent_id=? AND ts>=? ORDER BY ts ASC'),
  // 全量 sparklines SQL 层采样：窗口函数按 agent 分组，每 agent 最多保留 maxPoints 点（首尾+均匀间隔）。
  // 7d 窗口 757K 行→~7200 行（减少 100x 传输+JS 处理），max_points 由 clampInt 钳为整数故安全内插。
  // 审查 C4：SQL 本体移至 heavy-queries.js（主线程与 worker 线程共用）
  metricsSparklinesAllSampled: (sinceTs, maxPoints, untilTs) => heavyQueries.sparklinesAllSampled(db, sinceTs, maxPoints, untilTs),
  // 单节点 sparklines SQL 层采样（节点详情页专用）：与全量版同构，但按 agent_id 过滤。
  // 此前详情页单节点走「全量拉取 10.8 万行 → Node 侧 downsampleSparklines 降到 2000 点」，
  // 每次请求 2.77s + 220MB 峰值，30s 缓存一过就卡/偶发超时。SQL 层直接只返回 maxPoints 行。
  // 必须保留首尾点（rn=1 OR rn=cnt）：详情页磁盘耗尽预测依赖 disk_used 首末值做线性外推。
  // untilTs（可选）：取「前一等长窗口」时的上界——ts < untilTs。null 表示不设上界（现状行为）。
  metricsSparklinesOne: (agentId, sinceTs, maxPoints, untilTs) => {
    const step = Math.max(1, Math.floor(Number(maxPoints) || 1));
    return db.prepare(`
      WITH numbered AS (
        SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate,
               net_rx_month, net_tx_month,
               load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total,
               process_count,
               ROW_NUMBER() OVER (ORDER BY ts ASC) AS rn,
               COUNT(*) OVER () AS cnt
        FROM metrics WHERE agent_id=@agentId AND ts>=@since AND (@until IS NULL OR ts<@until)
      )
      SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate,
             net_rx_month, net_tx_month,
             load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total,
             process_count
      FROM numbered
      WHERE rn = 1 OR rn = cnt OR rn % MAX(1, CAST(cnt/CAST(@step AS INTEGER) AS INTEGER)) = 0
      ORDER BY ts ASC`).all({ agentId, since: sinceTs, step, until: untilTs == null ? null : Number(untilTs) });
  },
  // 集群级时间桶聚合（仪表盘平均 CPU/内存趋势专用）：跨所有 agent 按固定时间桶 GROUP BY，
  // 直接算出每个桶的 cpu/mem 平均值。返回行数=桶数（≤maxPoints），彻底规避「62 台 × 每 agent 2000 点
  // 全量拉到前端再逐点聚合」的主线程卡顿。SQL 引擎做聚合，只传输最终曲线。
  // spanMs: 窗口总时长（毫秒），用于按目标点数反推桶宽 = spanMs/maxPoints。
  // 注意：better-sqlite3 对绑定对象里的 number 默认绑成 REAL，导致 (ts-@since)/@bucket 变浮点除法、
  // 每个浮点值自成一组。故用 CAST(... AS INTEGER) 强制整数地板除法，保证分组数≈maxPoints。
  // 审查 C4：SQL 本体移至 heavy-queries.js（主线程与 worker 线程共用）
  metricsClusterAvg: (sinceTs, spanMs, maxPoints) => heavyQueries.clusterAvg(db, sinceTs, spanMs, maxPoints),
  // ---- AI 报告 ----
  insertAiReport: db.prepare(`INSERT INTO ai_reports
    (period, risk_level, summary, suggestion, report_json, prompt_version, created_at,
     prompt_tokens, completion_tokens, total_tokens, duration_ms, degraded)
    VALUES (@period, @risk_level, @summary, @suggestion, @report_json, @prompt_version, @created_at,
     @prompt_tokens, @completion_tokens, @total_tokens, @duration_ms, @degraded)`),
  getAiReport: db.prepare('SELECT * FROM ai_reports WHERE id = ?'),
  listAiReports: db.prepare('SELECT id, period, risk_level, summary, suggestion, prompt_version, created_at FROM ai_reports ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  countAiReports: db.prepare('SELECT COUNT(*) AS n FROM ai_reports'),
  pruneAiReports: db.prepare('DELETE FROM ai_reports WHERE created_at < ?'),
  // ---- AI 单节点报告（§8 T17）----
  insertAiNodeReport: db.prepare(`INSERT INTO ai_node_reports
    (agent_id, period_hours, status, risk_level, report_json, prompt_version, created_at,
     prompt_tokens, completion_tokens, total_tokens, duration_ms)
    VALUES (@agent_id, @period_hours, @status, @risk_level, @report_json, @prompt_version, @created_at,
     @prompt_tokens, @completion_tokens, @total_tokens, @duration_ms)`),
  // 列表刻意不取 report_json（单条可达数十 KB），只给渲染历史列表所需字段
  listAiNodeReports: db.prepare(`SELECT id, agent_id, period_hours, status, risk_level, prompt_version,
      prompt_tokens, completion_tokens, total_tokens, duration_ms, created_at
    FROM ai_node_reports WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`),
  pruneAiNodeReports: db.prepare('DELETE FROM ai_node_reports WHERE created_at < ?'),
  // AI 用量按 UTC 日聚合（day = created_at 的整数天序号），供后台展示 token 消耗趋势
  aiUsageDaily: db.prepare(`SELECT CAST(created_at / 86400000 AS INTEGER) AS day,
      COUNT(*) AS reports,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(total_tokens) AS total_tokens
    FROM ai_reports WHERE created_at >= ? GROUP BY day ORDER BY day ASC`)
};

const createAgent = (fields) => {
  const id = genId();
  const token = genToken();
  stmts.insertAgent.run({
    id,
    name: fields.name || id,
    token_hash: hashToken(token),
    merchant: fields.merchant || '',
    note: fields.note || '',
    expire_at: fields.expire_at || '',
    monthly_quota_gb: Number(fields.monthly_quota_gb) || 0,
    price: Number(fields.price) || 0,
    billing_cycle: (fields.billing_cycle === undefined || fields.billing_cycle === null || fields.billing_cycle === '' || isNaN(Number(fields.billing_cycle))) ? 30 : Number(fields.billing_cycle),
    currency: fields.currency || '¥',
    auto_renewal: fields.auto_renewal !== false ? 1 : 0,
    grp: fields.grp || '',
    country: (fields.country || '').toUpperCase().slice(0, 2),
    probe_targets: fields.probe_targets || '',
    // 审查 G4：自助注册默认待确认（pending=1）；后台手动创建不传即为 0
    pending: fields.pending ? 1 : 0,
    created_at: Date.now()
  });
  return { id, token };
};

// 审查 E1：取最近 N 条指标，按时间正序（旧→新）返回。
const getRecentMetrics = (agentId, n) => stmts.recentMetrics.all(agentId, Math.max(1, Math.floor(Number(n)) || 1)).reverse();

// 审查 G4：批准待确认 agent（管理员后台一键放行）。返回是否确有更新。
const approveAgent = (id) => stmts.approveAgent.run(id).changes > 0;

// 审查 E5：服务端侧月流量估算——按小时桶聚合 net_rx/tx_rate 后积分，
// 用于交叉校验受控端上报的月累计（接口计数重置 / state.json 丢失时上报值被
// 钳零而静默漏报）。桶聚合而非逐行积分：30 天原始行可达 17 万行/台，桶化后
// ≤720 行/台，成本可忽略；间隔异常（>1h，如断连）的桶间不计。
function trafficEstimateBucketed(agentId, sinceTs) {
  const rows = db.prepare(`
    SELECT CAST(ts/3600000 AS INTEGER) AS bucket,
           AVG(net_rx_rate) AS rx, AVG(net_tx_rate) AS tx
    FROM metrics WHERE agent_id=? AND ts>=?
    GROUP BY bucket ORDER BY bucket ASC`).all(agentId, sinceTs);
  let rx = 0, tx = 0;
  for (let i = 1; i < rows.length; i++) {
    const gapSec = (rows[i].bucket - rows[i - 1].bucket) * 3600;
    if (gapSec <= 0 || gapSec > 3600) continue;
    rx += (rows[i - 1].rx || 0) * gapSec;
    tx += (rows[i - 1].tx || 0) * gapSec;
  }
  return { rx, tx };
}

// 审查 G4：监控面 agent 列表——排除待确认（pending=1）的 agent。
// 待确认 agent 尚未获准上报，若进入统计会被误判为"离线节点"（刷误报）、
// 污染看板/公开页/AI 摘要。后台管理列表（GET /agents）仍用全量 getAgents()，
// 以便管理员看到待确认项并批准。
const getMonitoredAgents = () => stmts.getAgents.all().filter((a) => !a.pending);

// 审查 G4：自助注册累计计数（单 SETUP_TOKEN 可创建的 agent 数上限）。
// 存 admin_config（进程重启不丢）；令牌泄露时限制 rogue agent 批量注册。
const SELF_REG_COUNT_KEY = 'self_registered_count';
const getSelfRegisteredCount = () => Number(getConfig(SELF_REG_COUNT_KEY) || 0);
const bumpSelfRegisteredCount = () => {
  const n = getSelfRegisteredCount() + 1;
  setConfig(SELF_REG_COUNT_KEY, String(n));
  return n;
};

const getAgent = (id) => stmts.getAgent.get(id);
const getAgents = () => stmts.getAgents.all();
// 全量 sparklines SQL 层采样：窗口函数按 agent 分组，每 agent 最多保留 maxPoints 点。
const metricsSparklinesAllSampled = (sinceTs, maxPoints, untilTs) => stmts.metricsSparklinesAllSampled(sinceTs, maxPoints, untilTs);

// 集群级时间桶聚合（仪表盘平均曲线）：跨所有 agent 按时间桶求 cpu/mem 平均，返回行数≤maxPoints。
const metricsClusterAvg = (sinceTs, spanMs, maxPoints) => stmts.metricsClusterAvg(sinceTs, spanMs, maxPoints);

// 磁盘趋势：跨所有 agent 的桶聚合 disk_pct 序列（仅 ts/agent_id/disk_pct 三列），供 AI 日报趋势估计。
const metricsDiskTrendAll = (sinceTs, bucketMs) => stmts.metricsDiskTrendAll(sinceTs, bucketMs);

// 单节点 sparklines SQL 层采样（节点详情页）：只返回 maxPoints 行，保留首尾点供磁盘耗尽预测。
const getMetricsSparklinesOne = (agentId, sinceTs, maxPoints, untilTs) => stmts.metricsSparklinesOne(agentId, sinceTs, maxPoints, untilTs);

// 重置某 Agent 的 Token：生成新 token 并写入哈希，旧 token 立即失效。返回新明文 token。
const resetAgentToken = (id) => {
  const a = stmts.getAgent.get(id);
  if (!a) return null;
  const token = genToken();
  stmts.resetToken.run(hashToken(token), id);
  return token;
};


// 单节点探针 SQL 层采样（详情页延迟波形）：只返回 maxPoints 行，规避 9.5 万次 JSON.parse。
const getMetricsProbesOne = (agentId, sinceTs, maxPoints) => stmts.metricsProbesOne(agentId, sinceTs, maxPoints);

// 全量探针：只取 ts/agent_id/probes 三列，并按 agent 时间桶降采样（每 agent 最多 maxPoints 点），
// 规避 SELECT * 物化全列 + 330 万行全量读进内存触发 OOM（see getMetricsAll 教训）。
// 审查 C4：SQL 本体移至 heavy-queries.js（主线程与 worker 线程共用）
const metricsProbesAll = (sinceTs, maxPoints) => heavyQueries.probesAll(db, sinceTs, maxPoints);

// 审查 C4：重查询的主线程同步路径——worker 不可用（启动失败/崩溃/超时）时由
// heavy-db.js 回调至此，行为与改造前完全一致（可用性优先）。
const heavyQuerySync = (fn, args) => {
  const fns = {
    loadOne: (...a) => heavyQueries.loadOne(db, ...a),
    loadAll: (...a) => heavyQueries.loadAll(db, ...a),
    sparklinesAllSampled: (...a) => heavyQueries.sparklinesAllSampled(db, ...a),
    clusterAvg: (...a) => heavyQueries.clusterAvg(db, ...a),
    diskTrendAll: (...a) => heavyQueries.diskTrendAll(db, ...a),
    probesAll: (...a) => heavyQueries.probesAll(db, ...a),
  };
  if (!fns[fn]) throw new Error('unknown heavy fn: ' + fn);
  return fns[fn](...(args || []));
};

// sparkline 专用：只取指标列（不含 probes 大字段），规避 SELECT * 全行物化。
const getMetricsSparklines = (agentId, sinceTs) => stmts.metricsSparklines.all(agentId, sinceTs);

const updateAgent = (id, f) => {
  // P1 三态：仅当调用方显式携带 month_rotate 才更新；否则保留库中原值（可能是 NULL）。
  const current = stmts.getAgent.get(id);
  const monthRotate = Object.prototype.hasOwnProperty.call(f, 'month_rotate')
    ? traffic.normalizeRotate(f.month_rotate)
    : (current ? current.month_rotate : null);
  return stmts.updateAgent.run({
    id,
    name: f.name,
    merchant: f.merchant || '',
    note: f.note || '',
    expire_at: f.expire_at || '',
    monthly_quota_gb: Number(f.monthly_quota_gb) || 0,
    month_rotate: monthRotate,
    price: Number(f.price) || 0,
    billing_cycle: (f.billing_cycle === undefined || f.billing_cycle === null || f.billing_cycle === '' || isNaN(Number(f.billing_cycle))) ? 30 : Number(f.billing_cycle),
    currency: f.currency || '¥',
    auto_renewal: f.auto_renewal !== false ? 1 : 0,
    grp: f.grp || '',
    country: (f.country || '').toUpperCase().slice(0, 2),
    probe_targets: f.probe_targets || ''
  });
};

// F11（2026-10-24）：删除改为软删——一条 UPDATE，不碰 alert_state / alert_overrides
//（7 天内恢复时告警冷却连续，不会立刻重复通知）。物理清理见 purgeDeletedAgents()。
const deleteAgent = (id) => stmts.softDeleteAgent.run(Date.now(), id).changes;
const listDeletedAgents = () => stmts.getDeletedAgents.all();
const getAgentIncludingDeleted = (id) => stmts.getAgentIncludingDeleted.get(id);
const restoreAgent = (id) => stmts.restoreAgentRow.run(id).changes;

// F11：软删缓冲期（固定 7 天，见 IMPLEMENTATION_PLAN §5 F11）。
const SOFT_DELETE_GRACE_MS = 7 * 86400000;

const tableExists = (name) => Boolean(
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
);

// F11：物理清理过期软删节点。顺序不可换：
//   ① 显式清无 FK 的状态表（alert_state / alert_overrides）+ 内存 trafficCache；
//   ② metrics_hour（S2 折叠表）按约定不声明 FK，存在时显式删；
//   ③ 最后删 agents 行 —— 此时 metrics / traffic_state 由 FK CASCADE 带走。
// 每条节点清理包在 db.transaction 内：任一语句失败整体回滚，不留「半清理」。
const purgeDeletedAgents = (now = Date.now()) => {
  const rows = stmts.expiredDeletedAgents.all(now - SOFT_DELETE_GRACE_MS);
  if (!rows.length) return 0;
  const delHour = tableExists('metrics_hour')
    ? db.prepare('DELETE FROM metrics_hour WHERE agent_id=?')
    : null;
  const purgeOne = db.transaction((id) => {
    stmts.purgeAlertState.run(id);
    stmts.purgeAlertOverride.run(id);
    if (delHour) delHour.run(id);
    trafficCache.delete(id);
    stmts.hardDeleteAgent.run(id);
  });
  for (const r of rows) purgeOne(r.id);
  return rows.length;
};

// ---- 告警覆盖（S1/F1）-------------------------------------------------------
// 字段范围与 resolveAlertThresholds() 保持一致；越界/非数字 → null（视为未设置）。
const ALERT_OVERRIDE_LIMITS = {
  offline_sec: [10, 86400],
  cpu_pct: [1, 100],
  mem_pct: [1, 100],
  disk_pct: [1, 100],
  temp_c: [-50, 200],
  cooldown: [60, 86400]
};
const ALERT_OVERRIDE_KEYS = Object.keys(ALERT_OVERRIDE_LIMITS);

function normAlertOverrideValue(key, v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const [min, max] = ALERT_OVERRIDE_LIMITS[key];
  return Math.min(max, Math.max(min, n));
}

// 合并语义：fields 中出现的键覆盖旧值（显式 null = 清除该字段回退上层），
// 未出现的键保留原值。muted 为并集语义（节点或分组任一为 1 即静音，见 alerts.js）。
function mergeOverrideRow(base, fields) {
  const row = {};
  for (const k of ALERT_OVERRIDE_KEYS) {
    row[k] = Object.prototype.hasOwnProperty.call(fields, k)
      ? normAlertOverrideValue(k, fields[k])
      : (base && base[k] !== undefined ? base[k] : null);
  }
  row.muted = Object.prototype.hasOwnProperty.call(fields, 'muted')
    ? (fields.muted ? 1 : 0)
    : (base && base.muted ? 1 : 0);
  return row;
}

function upsertAlertOverride(agentId, fields) {
  const base = stmts.getAlertOverride.get(agentId);
  const row = mergeOverrideRow(base, fields || {});
  stmts.upsertAlertOverride.run(Object.assign({ agent_id: agentId, updated_at: Date.now() }, row));
  return stmts.getAlertOverride.get(agentId);
}

function upsertGroupAlertOverride(grp, fields) {
  const key = typeof grp === 'string' ? grp : '';
  const base = stmts.getGroupAlertOverride.get(key);
  const row = mergeOverrideRow(base, fields || {});
  stmts.upsertGroupAlertOverride.run(Object.assign({ grp: key, updated_at: Date.now() }, row));
  return stmts.getGroupAlertOverride.get(key);
}

const getAlertOverride = (agentId) => stmts.getAlertOverride.get(agentId) || null;
const listAlertOverrides = () => stmts.listAlertOverrides.all();
const deleteAlertOverride = (agentId) => stmts.deleteAlertOverride.run(agentId).changes > 0;
const getGroupAlertOverride = (grp) => stmts.getGroupAlertOverride.get(grp || '') || null;
const listGroupAlertOverrides = () => stmts.listGroupAlertOverrides.all();
const deleteGroupAlertOverride = (grp) => stmts.deleteGroupAlertOverride.run(grp || '').changes > 0;

// ---- 通知渠道/通知组（S1/F2）----------------------------------------------
function channelOut(r) {
  let config = {};
  try { config = JSON.parse(r.config || '{}'); } catch (e) { config = {}; }
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    enabled: !!r.enabled,
    config,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

const listNotifyChannels = () => stmts.listNotifyChannels.all().map(channelOut);
const getNotifyChannel = (id) => {
  const r = stmts.getNotifyChannel.get(Number(id));
  return r ? channelOut(r) : null;
};

function createNotifyChannel(input) {
  const now = Date.now();
  const r = stmts.insertNotifyChannel.run({
    type: input.type,
    name: input.name,
    enabled: input.enabled === false ? 0 : 1,
    config: JSON.stringify(input.config || {}),
    created_at: now,
    updated_at: now
  });
  return getNotifyChannel(Number(r.lastInsertRowid));
}

function updateNotifyChannel(id, patch) {
  const cur = getNotifyChannel(id);
  if (!cur) return null;
  stmts.updateNotifyChannel.run({
    id: Number(id),
    name: patch.name !== undefined ? String(patch.name) : cur.name,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (cur.enabled ? 1 : 0),
    config: patch.config !== undefined ? JSON.stringify(patch.config) : JSON.stringify(cur.config),
    updated_at: Date.now()
  });
  return getNotifyChannel(id);
}

function deleteNotifyChannel(id) {
  stmts.deleteGroupChannelByChannel.run(Number(id));
  return stmts.deleteNotifyChannel.run(Number(id)).changes > 0;
}

function groupOut(g) {
  let events = [];
  try { events = JSON.parse(g.events || '[]'); } catch (e) { events = []; }
  return {
    id: g.id,
    name: g.name,
    enabled: !!g.enabled,
    events,
    channel_ids: stmts.listGroupChannelIds.all(g.id).map((r) => r.channel_id),
    created_at: g.created_at,
    updated_at: g.updated_at
  };
}

const listNotifyGroups = () => stmts.listNotifyGroups.all().map(groupOut);
const getNotifyGroup = (id) => {
  const g = stmts.getNotifyGroup.get(Number(id));
  return g ? groupOut(g) : null;
};

function replaceGroupChannels(groupId, channelIds) {
  stmts.clearGroupChannels.run(groupId);
  for (const cid of channelIds || []) stmts.bindGroupChannel.run(groupId, Number(cid));
}

function createNotifyGroup(input) {
  const now = Date.now();
  const r = stmts.insertNotifyGroup.run({
    name: input.name,
    events: JSON.stringify(input.events || []),
    enabled: input.enabled === false ? 0 : 1,
    created_at: now,
    updated_at: now
  });
  const id = Number(r.lastInsertRowid);
  replaceGroupChannels(id, input.channel_ids);
  return getNotifyGroup(id);
}

function updateNotifyGroup(id, patch) {
  const cur = getNotifyGroup(id);
  if (!cur) return null;
  stmts.updateNotifyGroup.run({
    id: Number(id),
    name: patch.name !== undefined ? String(patch.name) : cur.name,
    events: patch.events !== undefined ? JSON.stringify(patch.events) : JSON.stringify(cur.events),
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (cur.enabled ? 1 : 0),
    updated_at: Date.now()
  });
  if (patch.channel_ids !== undefined) replaceGroupChannels(Number(id), patch.channel_ids);
  return getNotifyGroup(id);
}

function deleteNotifyGroup(id) {
  stmts.clearGroupChannels.run(Number(id));
  return stmts.deleteNotifyGroup.run(Number(id)).changes > 0;
}

// 投递用：启用组中订阅了 event（或 '*'）的所有启用渠道，按 channel_id 去重。
// 每次调用直接查库（不做缓存）——配置修改即时生效，规模（组/渠道个位数）下开销可忽略。
function listEnabledChannelsForEvent(event) {
  const groupIds = new Set();
  for (const g of stmts.listEnabledGroupsForEvent.all()) {
    let events = [];
    try { events = JSON.parse(g.events || '[]'); } catch (e) { events = []; }
    if (events.includes('*') || events.includes(event)) groupIds.add(g.id);
  }
  if (!groupIds.size) return [];
  const channelIds = new Set();
  for (const row of stmts.listGroupChannelRows.all()) {
    if (groupIds.has(row.group_id)) channelIds.add(row.channel_id);
  }
  if (!channelIds.size) return [];
  return stmts.listNotifyChannels.all().map(channelOut).filter((c) => c.enabled && channelIds.has(c.id));
}

// ---- S1/F2：通知种子迁移（幂等）----
// 任何 require 本模块的入口（server/测试/CLI）都会执行。UNIQUE(type,name) +
// INSERT OR IGNORE 保证重复启动不重复插；仅当 notify_groups 为空时建默认组。
function initNotifyMigrationIfNeeded() {
  try {
    const now = Date.now();
    stmts.insertChannelIfAbsent.run('mail', 'mail', now, now);
    stmts.insertChannelIfAbsent.run('telegram', 'telegram', now, now);
    if (stmts.countNotifyGroups.get().n === 0) {
      const r = stmts.insertNotifyGroup.run({
        name: 'default', events: JSON.stringify(['*']), enabled: 1, created_at: now, updated_at: now
      });
      const gid = Number(r.lastInsertRowid);
      for (const ch of stmts.listNotifyChannels.all()) stmts.bindGroupChannel.run(gid, ch.id);
    }
  } catch (e) {
    console.error('[db] notify seed migration failed:', e.message);
  }
}
initNotifyMigrationIfNeeded();

// ---- S2/F5：API Token -------------------------------------------------------
// 明文格式 diting_<48hex>，仅在创建时返回一次；id 为 tok_<12hex>（可安全展示/审计）。
const genApiTokenPlain = () => 'diting_' + crypto.randomBytes(24).toString('hex');
const genApiTokenId = () => 'tok_' + crypto.randomBytes(6).toString('hex');

function apiTokenOut(r) {
  let agentIds = [];
  try { agentIds = JSON.parse(r.agent_ids || '[]'); } catch (e) { agentIds = []; }
  return {
    id: r.id,
    name: r.name,
    scope: r.scope,
    agent_ids: Array.isArray(agentIds) ? agentIds : [],
    expires_at: r.expires_at,
    last_used_at: r.last_used_at,
    last_used_ip: r.last_used_ip,
    created_at: r.created_at,
    created_by: r.created_by,
    revoked: !!r.revoked
  };
}

function createApiToken(input) {
  const id = genApiTokenId();
  const token = genApiTokenPlain();
  const agentIds = Array.isArray(input.agentIds) ? input.agentIds.map(String).slice(0, 500) : [];
  stmts.insertApiToken.run({
    id,
    name: String(input.name || '').slice(0, 64),
    token_hash: hashToken(token),
    scope: input.scope === 'admin' ? 'admin' : 'readonly',
    agent_ids: JSON.stringify(agentIds), // 显式写 '[]'，不依赖 DB 默认值
    expires_at: Number(input.expiresAt) || 0,
    created_at: Date.now(),
    created_by: String(input.createdBy || '').slice(0, 64)
  });
  return { id, token };
}

const findApiTokenByHash = (hash) => {
  const r = stmts.getApiTokenByHash.get(hash);
  return r ? apiTokenOut(r) : null;
};
const getApiToken = (id) => {
  const r = stmts.getApiTokenById.get(id);
  return r ? apiTokenOut(r) : null;
};
const listApiTokens = () => stmts.listApiTokens.all().map(apiTokenOut);
const revokeApiToken = (id) => stmts.revokeApiToken.run(id).changes > 0;

// last_used 节流：同一 token 60s 内只写一次库（高频只读 Token 下避免每请求写放大）。
const _apiTokenTouch = new Map();
function touchApiToken(id, ip) {
  const now = Date.now();
  const last = _apiTokenTouch.get(id) || 0;
  if (now - last < 60 * 1000) return;
  if (_apiTokenTouch.size >= 10000) _apiTokenTouch.clear();
  _apiTokenTouch.set(id, now);
  try { stmts.touchApiToken.run(now, String(ip || '').slice(0, 64), id); } catch (e) { /* 追踪失败不影响鉴权 */ }
}

// ---- S2/F6：登录会话 --------------------------------------------------------
const genSessionId = () => crypto.randomBytes(12).toString('hex');

function createSessionRow({ id, admin, ip, ua }) {
  const now = Date.now();
  const sid = id || genSessionId();
  stmts.insertSession.run({
    id: sid,
    admin: String(admin || 'admin').slice(0, 64),
    ip: String(ip || '').slice(0, 64),
    ua: String(ua || '').slice(0, 255),
    created_at: now,
    last_seen: now
  });
  return sid;
}

const getSessionRow = (id) => stmts.getSessionRow.get(id) || null;
const listSessions = () => stmts.listSessions.all();
const revokeSession = (id) => stmts.revokeSession.run(id).changes > 0;
const revokeAllSessionRows = () => stmts.revokeAllSessionRows.run().changes;
// 批量吊销但保留指定会话（后台「踢出其它设备」）：只标记表内行，不动全局水位线。
const revokeAllSessionRowsExcept = (keepId) => stmts.revokeAllSessionRowsExcept.run(String(keepId || '')).changes;
const pruneSessions = (before) => stmts.pruneSessions.run(Number(before) || 0).changes;

// last_seen 节流：每会话 60s 写一次，避免每次 API 请求都写库。
const _sessionTouch = new Map();
function touchSession(id) {
  const now = Date.now();
  const last = _sessionTouch.get(id) || 0;
  if (now - last < 60 * 1000) return;
  if (_sessionTouch.size >= 10000) _sessionTouch.clear();
  _sessionTouch.set(id, now);
  try { stmts.touchSession.run(now, id); } catch (e) { /* 忽略 */ }
}

const touchAgent = (id, os, hostname, version) =>
  stmts.touch.run(Date.now(), os || '', hostname || '', version || '', id);

// 记录受控端核数（§9 T18）：仅接受 1–1024 的整数；其余（含老 agent 的缺失）一律忽略，
// 保持库中为 0 = 未知——摘要侧据此输出 cores_unknown，绝不用 0/1 冒充分母。
const setAgentCores = (id, cores) => {
  const n = Math.floor(Number(cores));
  if (!Number.isFinite(n) || n < 1 || n > 1024) return 0;
  return stmts.setAgentCores.run(n, id, n).changes;
};

// 兜底默认值：process_count 为 0（= 未采集/老 agent 不带该字段）。
// 先展开默认值再展开 m，保证 m 中的真实值覆盖默认。
// insertMetric 列默认值：新列（interval 等）与老调用方（测试/脚本）字段不齐全时
// 统一补默认，避免 better-sqlite3 "Missing named parameter" 直接抛错。
// 生产路径由 validateReport 始终提供齐全字段，此处仅为兜底（曾只给 process_count
// 补默认，新增 interval 列时测试即暴露了其余列仍会抛错的调用方陷阱）。
const METRIC_DEFAULTS = {
  cpu: 0, mem_used: 0, mem_total: 0, mem_pct: 0,
  disk_used: 0, disk_total: 0, disk_pct: 0,
  load1: 0, load5: 0, load15: 0,
  net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0, uptime: 0,
  temp: null, swap_used: 0, swap_total: 0, swap_pct: 0,
  disk_r_rate: 0, disk_w_rate: 0, probes: '{}', disks: '[]',
  process_count: 0, interval: 0
};
const insertMetric = (agent_id, m) => stmts.insertMetric.run(Object.assign({}, METRIC_DEFAULTS, m, { agent_id }));

// ---- P1 服务端流量累加器：内存 Map + 节流落盘，/report 热路径不打 SQLite ----
const trafficCache = new Map(stmts.allTrafficState.all().map((r) => [r.agent_id, r]));
const trafficDirty = new Set();

const accumulateTraffic = (agentId, report, nowMs = Date.now()) => {
  const agent = stmts.getAgent.get(agentId);
  if (!agent) return null;
  let state = trafficCache.get(agentId);
  if (!state) {
    state = traffic.emptyState(agentId);
    trafficCache.set(agentId, state);
  }
  const tzOffsetHours = Number(getAiConfig().tz_offset_hours) || 0;
  const out = traffic.accumulate(state, agent, report, nowMs, tzOffsetHours);
  report.net_rx_month = out.used_rx;
  report.net_tx_month = out.used_tx;
  trafficDirty.add(agentId);
  return out;
};

// has_counter：traffic_state 已有绝对计数器基线（last_rx/last_tx 非 NULL）即视为 Go 口径节点。
const hasTrafficCounter = (agentId) => {
  const s = trafficCache.get(agentId);
  return !!(s && s.last_rx !== null && s.last_rx !== undefined && s.last_tx !== null && s.last_tx !== undefined);
};

const flushTraffic = () => {
  if (!trafficDirty.size) return;
  const rows = [];
  for (const id of trafficDirty) {
    const s = trafficCache.get(id);
    if (s) rows.push(s);
  }
  if (!rows.length) { trafficDirty.clear(); return; }
  const tx = db.transaction((list) => {
    for (const s of list) stmts.upsertTrafficState.run(s);
  });
  tx(rows);
  trafficDirty.clear();
};

// F8.6：恢复后检测到流量缺口时重置基线。
// last_rx/last_tx 置 NULL 表示「下一条上报只建基线」——traffic.js 的
// `last_rx !== null` 分支不成立，缺口期间累计的增量不会被一次性算进当月
// （否则 max(baseRx - last_rx, 0) 会把整段缺口算成当月用量，可能误触配额告警）。
// 内存缓存必须同步修改：否则下一次 flush 会把旧 last_rx 写回，覆盖刚做的修复。
const markTrafficGap = (agentId, nowMs = Date.now()) => {
  const s = trafficCache.get(agentId);
  if (s) {
    s.last_rx = null;
    s.last_tx = null;
    s.last_ts = nowMs;
    s.updated_at = nowMs;
    trafficDirty.add(agentId);
  }
  db.prepare('UPDATE traffic_state SET last_rx=NULL, last_tx=NULL, last_ts=?, updated_at=? WHERE agent_id=?')
    .run(nowMs, nowMs, agentId);
};

// F8.1：应用内一致性快照。better-sqlite3 的 db.backup() 是异步在线备份
// （逐页拷贝已提交内容），无需停服，也不受 rollback journal 写窗口影响。
// 返回 Promise；调用方负责目录创建、目标名冲突检查与权限收紧。
const backupTo = (dest) => db.backup(dest);

const trafficFlushTimer = setInterval(flushTraffic, 60000);
trafficFlushTimer.unref();
process.once('exit', () => {
  try { if (fs.existsSync(DB_PATH)) flushTraffic(); } catch { /* 退出兜底失败不阻断 */ }
});

const getLatestMetric = (agent_id) => stmts.latestMetric.get(agent_id);

// 窗口内有上报数据的节点数（走 idx_metrics_ts 覆盖扫描，毫秒级）
const countActiveAgents = (sinceTs) => (stmts.countActiveAgents.get(sinceTs) || {}).c || 0;
// 单节点全字段采样：只返回 ≤maxPoints 行（保留首尾），替代 getMetrics 全量拉取。
const getMetricsSampled = (agent_id, sinceTs, maxPoints) =>
  stmts.metricsRangeSampled(agent_id, sinceTs, maxPoints);

// 负载曲线采样（不含 probes/disks 大字段）：单节点 / 跨节点两版
const getMetricsLoadOne = (agent_id, sinceTs, maxPoints) =>
  stmts.metricsLoadOne(agent_id, sinceTs, maxPoints);
const getMetricsLoadAll = (sinceTs, maxPoints) => stmts.metricsLoadAll(sinceTs, maxPoints);

const prune = (retentionDays) => {
  const cutoff = Date.now() - retentionDays * 86400000;
  const r = stmts.prune.run(cutoff);
  // 删完立刻把空闲页还给文件系统（仅 auto_vacuum=INCREMENTAL 时有效；
  // 其它模式是 no-op，不会报错）。不这么做的话文件只涨不缩。
  if (r.changes > 0) {
    try { db.pragma('incremental_vacuum'); } catch (e) {
      console.warn('[db] incremental_vacuum 失败（不影响清理）:', e.message);
    }
  }
  return r.changes;
};

const getAlertState = (agent_id, type) => stmts.getAlertState.get(agent_id, type);
const setAlertState = (agent_id, type, ts) => stmts.setAlertState.run(agent_id, type, ts);
const clearAlertState = (agent_id, type) => stmts.clearAlertState.run(agent_id, type);

// ---- Admin 2FA (TOTP) 配置（单管理员模型，key-value）----
const _getCfg = db.prepare('SELECT value FROM admin_config WHERE key = ?');
const _setCfg = db.prepare('INSERT OR REPLACE INTO admin_config (key, value) VALUES (?, ?)');
const _setCfgIfAbsent = db.prepare('INSERT OR IGNORE INTO admin_config (key, value) VALUES (?, ?)');
const _delCfg = db.prepare('DELETE FROM admin_config WHERE key = ?');
const TWOFA_SECRET = 'admin_2fa_secret';
const TWOFA_ENABLED = 'admin_2fa_enabled';
const getConfig = (k) => { const r = _getCfg.get(k); return r ? r.value : null; };
const setConfig = (k, v) => _setCfg.run(k, String(v));
// 仅当 key 不存在时写入（依赖 key 主键唯一性）。返回 true 表示本次写入成功。
// 用于 /api/setup/generate 防并发竞态：多个请求同时到达时只有一个能落库，其余返回 false。
const setConfigIfAbsent = (k, v) => _setCfgIfAbsent.run(k, String(v)).changes > 0;
// 删除配置项。返回 true 表示确实删了一行。用于安装向导 complete 失败时回滚初始化状态、
// 清理历史残留（旧 admin_initialized 锁、明文 admin_token_raw）。
const deleteConfig = (k) => _delCfg.run(k).changes > 0;

// ---- 管理员 Token：只存 sha256 哈希，库文件泄露不等于拿到 Token ----
// 明文只存在于用户手里（向导一次性展示 / reset 脚本一次性打印），永不落盘。
const ADMIN_TOKEN_HASH = 'admin_token_hash';
const getAdminTokenHash = () => getConfig(ADMIN_TOKEN_HASH) || '';
const setAdminTokenHash = (h) => setConfig(ADMIN_TOKEN_HASH, String(h || ''));
// 原子抢写：多实例/并发安装时只有一个能落库，其余返回 false（即"已安装"，防重装）。
const setAdminTokenHashIfAbsent = (h) => setConfigIfAbsent(ADMIN_TOKEN_HASH, String(h || ''));
const clearAdminTokenHash = () => deleteConfig(ADMIN_TOKEN_HASH);
// ---- 受控端自助注册令牌（SETUP_TOKEN）：库为权威，env 仅作一次性迁移源 ----
// 与 AI Key / SMTP 密码同口径：明文存 SQLite（库 600，DB 无加密），
// 好处是可在管理面直接改，不必登机器改 .env 再重启容器。
// 回退逻辑在 api.js resolveSetupToken()：库有值用库，库空才读 env。
const SETUP_TOKEN_KEY = 'setup_token';
const SETUP_TOKEN_CLEARED_KEY = 'setup_token_cleared';
const getSetupToken = () => getConfig(SETUP_TOKEN_KEY) || '';
const setSetupToken = (v) => setConfig(SETUP_TOKEN_KEY, String(v || ''));
const clearSetupToken = () => deleteConfig(SETUP_TOKEN_KEY);
// 管理面显式清除后的"墓碑"：否则 resolveSetupToken 会把 .env 的残留值反复搬回库。
const isSetupTokenCleared = () => getConfig(SETUP_TOKEN_CLEARED_KEY) === '1';
const markSetupTokenCleared = () => setConfig(SETUP_TOKEN_CLEARED_KEY, '1');
const unmarkSetupTokenCleared = () => deleteConfig(SETUP_TOKEN_CLEARED_KEY);
const get2FASecret = () => getConfig(TWOFA_SECRET);
const is2FAEnabled = () => getConfig(TWOFA_ENABLED) === '1';
const set2FASecret = (s) => setConfig(TWOFA_SECRET, s);
const set2FAEnabled = (b) => setConfig(TWOFA_ENABLED, b ? '1' : '0');

// ---- UI / 通知设置（持久化到 admin_config 的 key-value）----
const SETTINGS_KEY = 'ui_settings';
const NOTIFY_KEY = 'notify_config';
const BACKUP_STATE_KEY = 'backup_state';
function getUiSettings() {
  const def = { site_title: '', site_description: '', site_url: '', custom_css: '', default_sort: 'created', group_order: [], agent_server_url: '', admin_allow_ips: '', alert: { cpu_pct: 90, mem_pct: 90, offline_sec: 60 }, public_enabled: true,
    // 公开接口（/api/public/agents、/api/v1/nodes）是否透出业务字段：
    // 商家 merchant、到期 expire_at、备注 note、月流量配额 monthly_quota_gb、套餐 price/billing_cycle/currency。
    // 默认 true 与旧版行为一致（公开页首页「商家数/即将到期」与详情页「备注/套餐」依赖这些字段）；
    // 若公开页面向外部访客、不希望暴露经营信息，在后台设置里关闭即可，公开页会自动隐藏相关模块。
    public_show_business: true,
    home_layout: 'grid', public_theme: 'default', probe_targets: 'CM:www.10086.cn:443,CT:101.226.4.6,CU:202.106.0.20,GG:8.8.8.8', retention_days: 30, social_email: '', social_telegram: '', social_qq: '', social_website: '',
    // 主题可视化配置（对齐 komari-theme-Glassmorphism）
    glass_preset: 'emerald',          // 毛玻璃配色预设：emerald/soft/high-contrast/midnight/custom
    glass_custom: {},                 // 自定义毛玻璃配色（light/dark 各 5 色）
    color_vision: 'normal',           // 色觉辅助：normal/protanopia/deuteranopia/tritanopia
    card_scheme: 'official',          // 首页总览卡片方案：official/basic/ops/resource/finance/traffic/gpu/asset/full
    card_size: 'comfortable',         // 节点卡片尺寸：mini/compact/comfortable/large
    // 后台仪表盘布局（对齐 Komari）：[{id,width,height}] 有序数组；
    // null = 从未配置（前端用默认布局），[] = 用户清空全部卡片
    admin_dashboard_layout: null,
    background: { enabled: false, type: 'image', url: '', blur: 8, overlay: 50 }, // 背景图/视频
    announcement: { enabled: false, title: '', content: '' }, // 公告
    provider_aliases: {},             // 厂商别名映射 { "原始厂商": "显示名" }
    custom_tags: {},                  // 节点自定义标签 { "agent_id": "标签文本" }
    visitor_info: false,              // 访客信息条（底部 IP 条）
    // ---- 数据库备份（由宿主侧 diting.sh 消费，服务端不执行备份）----
    // 备份在宿主机执行（容器内访问不到宿主备份目录），这里只存策略，
    // 由 cron 每日触发 diting.sh --backup，脚本启动后读这些值决定「今天是否该跑」。
    // 因此改周期无需改动 crontab，配置即时生效。
    backup_schedule: 'off',           // off / daily / weekly（weekly 在周一执行）
    backup_hour: 3,                   // 执行小时 0-23
    backup_keep_days: 14,             // 保留天数（0=不自动清理）
    backup_compress: true             // gzip 压缩（实测体积约 20%，强烈建议开启）
  };
  try {
    const o = JSON.parse(getConfig(SETTINGS_KEY) || '{}');
    const merged = Object.assign(def, o);
    // 嵌套对象（alert）需单独合并，避免服务端缺字段时整体回退到默认
    merged.alert = Object.assign(def.alert, (o && o.alert) || {});
    return merged;
  }
  catch (e) { return def; }
}
function setUiSettings(o) { setConfig(SETTINGS_KEY, JSON.stringify(o || {})); }
function getNotifyConfigRaw() {
  try { return JSON.parse(getConfig(NOTIFY_KEY) || '{}'); } catch (e) { return {}; }
}
// 通知配置：UI 保存值优先，缺失项回退到 docker-compose 环境变量默认值。
function getNotifyConfig() {
  const def = {
    smtp_host: process.env.SMTP_HOST || 'smtp.qq.com',
    smtp_port: Number(process.env.SMTP_PORT || 465),
    smtp_secure: process.env.SMTP_SECURE !== 'false',
    smtp_user: process.env.SMTP_USER || '',
    smtp_pass: process.env.SMTP_PASS || '',
    alert_from: process.env.ALERT_FROM || process.env.SMTP_USER || '',
    alert_to: process.env.ALERT_TO || process.env.SMTP_USER || '',
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
    telegram_chat_id: process.env.TELEGRAM_CHAT_ID || ''
  };
  return Object.assign(def, getNotifyConfigRaw());
}
function setNotifyConfig(incoming) {
  const cur = getNotifyConfigRaw();
  const merged = Object.assign({}, cur, incoming || {});
  // 密码类字段留空表示「保持不变」，避免保存时空字符串误清空已存凭据
  if (incoming && incoming.smtp_pass === '' && cur.smtp_pass) merged.smtp_pass = cur.smtp_pass;
  if (incoming && incoming.telegram_bot_token === '' && cur.telegram_bot_token) merged.telegram_bot_token = cur.telegram_bot_token;
  setConfig(NOTIFY_KEY, JSON.stringify(merged));
}

// 数据保留天数：优先级为「显式存储的 DB 值 > 环境变量 RETENTION_DAYS > 硬编码默认 30」。
// 返回 [7, 3650] 范围内整数，超出则钳制，解析失败回退下一级。
function getRetentionDays() {
  // ① 仅当用户在后台显式设置过（非默认合并值）才优先使用
  try {
    const raw = getConfig(SETTINGS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && o.retention_days !== undefined && o.retention_days !== null && o.retention_days !== '') {
        const n = Number(o.retention_days);
        if (Number.isFinite(n) && n > 0) return Math.min(3650, Math.max(7, Math.floor(n)));
      }
    }
  } catch (e) {}
  // ② 回退到环境变量
  const env = Number(process.env.RETENTION_DAYS);
  if (Number.isFinite(env) && env > 0) return Math.min(3650, Math.max(7, Math.floor(env)));
  // ③ 最终默认
  return 30;
}

// 审查 C-1/E2：告警阈值单一取值函数（收敛此前的"双源分裂"）。
// 修复前：alerts.js 用 `alertCfg.xxx || env || 默认`，而 getUiSettings() 的嵌套合并
// （merged.alert = Object.assign(def.alert, …）使 alertCfg.xxx 恒为真值（默认 60），
// env 分支永远不可达——看板/兼容层直读 env（.env 设 120）判在线，告警按 60 判离线，
// 同一节点两套口径，平稳期周期性误报。ALERT_CPU_PCT/ALERT_MEM_PCT 同为死配置。
// 现在与 getRetentionDays 同款三级优先级：UI 显式存储值 > 环境变量 > 硬编码默认。
function resolveAlertThresholds() {
  let storedAlert = {};
  try {
    const raw = getConfig(SETTINGS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o.alert === 'object' && o.alert) storedAlert = o.alert;
    }
  } catch (e) {}
  const pick = (key, envName, def, min, max) => {
    const v = storedAlert[key];
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.min(max, Math.max(min, Math.floor(n)));
    }
    const env = Number(process.env[envName]);
    if (Number.isFinite(env) && env > 0) return Math.min(max, Math.max(min, Math.floor(env)));
    return def;
  };
  return {
    offline_sec: pick('offline_sec', 'OFFLINE_THRESHOLD_SEC', 60, 10, 86400),
    cpu_pct: pick('cpu_pct', 'ALERT_CPU_PCT', 90, 1, 100),
    mem_pct: pick('mem_pct', 'ALERT_MEM_PCT', 90, 1, 100),
    // 审查 E6：补磁盘/温度阈值（此前只有 cpu/mem，disk_pct/temp 采了却不告警）
    disk_pct: pick('disk_pct', 'DISK_ALERT_PCT', 90, 1, 100),
    temp_c: pick('temp_c', 'TEMP_ALERT_C', 80, 1, 200)
  };
}

// 审查 E2/E3：观测某 agent 的实际上报间隔（相邻 ts 差的中位数，秒）。
// 背景：服务端拿不到 agent 侧 SLOW_INTERVAL（agent 侧 env，全仓 0 引用），
// 自适应 agent 实际间隔在 10–60s 间变化；按 AGENT_INTERVAL 固定值（默认 20s）
// 估算"超阈值分钟数"最多偏差 3 倍（E3），也无法校验离线阈值是否小于
// 2× 实际上报间隔（E2 误报的根因）。这里用最近 windowMs 的原始行直接测量
// （中位数对偶发断连造成的间隔突增鲁棒）。样本不足返回 null，由调用方回退。
function observedIntervalSec(agentId, windowMs) {
  const since = Date.now() - (windowMs || 2 * 3600000);
  const rows = db.prepare('SELECT ts FROM metrics WHERE agent_id=? AND ts>=? ORDER BY ts ASC').all(agentId, since);
  if (rows.length < 3) {
    // 样本不足（新 agent / 刚清库）：回退到受控端上报的 interval 字段（审查 C-1 方案①）
    try {
      const row = db.prepare('SELECT interval FROM metrics WHERE agent_id=? AND interval>0 ORDER BY ts DESC LIMIT 1').get(agentId);
      if (row && row.interval > 0) return row.interval;
    } catch (e) {}
    return null;
  }
  const diffs = [];
  for (let i = 1; i < rows.length; i++) {
    const d = (rows[i].ts - rows[i - 1].ts) / 1000;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  const mid = diffs.length >> 1;
  const median = diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
  return Math.max(1, Math.round(median));
}

// ---- AI 运维分析（配置持久化到 admin_config，报告持久化到 ai_reports）----
const AI_CONFIG_KEY = 'ai_config';
const AI_STATE_KEY = 'ai_state';
// AI 配置：UI 保存值优先，缺失项回退到硬编码默认（与 notify_config 同款模式）。
// 注意：api_key 与现有 smtp_pass / telegram_bot_token 同级，均明文存 SQLite（DB 无加密）。
// getAiConfig() 返回明文 api_key，仅供服务端调用；对外 API 必须脱敏（见 api.js）。
function getAiConfig() {
  const def = {
    enabled: false,
    provider: 'openai',          // V1 只实现 OpenAI 兼容协议；base_url 可指向 DeepSeek/Ollama 等兼容端点
    base_url: '',                 // 留空走官方 https://api.openai.com/v1
    model: 'gpt-4o-mini',
    api_key: '',
    schedule_freq: 'daily',       // daily | weekly（友好下拉式，不暴露 cron 语法）
    schedule_time: '08:00',       // HH:MM，按 tz_offset_hours 解释
    tz_offset_hours: 8,           // 默认东八区
    locale: 'zh-CN',              // 通知正文语言：zh-CN | en（跟随后台设置，默认中文）
    log_retention_days: 30,       // AI 日报保留天数（与 metrics 保留期独立）
    silent_days: 3,               // 长期离线沉默期（天）：超过则标 stale，不逐台写进日报（0=关闭）
    node_cache_ttl_minutes: 30,   // 单节点分析结果缓存（分钟）：下限 30，可上调（§8 T17）
    period_hours: 24              // 报告统计窗口（小时）：24=日报，168=周报
  };
  try {
    const o = JSON.parse(getConfig(AI_CONFIG_KEY) || '{}');
    return Object.assign(def, o);
  } catch (e) { return def; }
}
function getAiConfigRaw() {
  try { return JSON.parse(getConfig(AI_CONFIG_KEY) || '{}'); } catch (e) { return {}; }
}
function setAiConfig(incoming) {
  const cur = getAiConfigRaw();
  const merged = Object.assign({}, cur, incoming || {});
  // api_key 留空表示「保持不变」，避免保存时空字符串误清空已存密钥（同 setNotifyConfig 模式）
  if (incoming && incoming.api_key === '' && cur.api_key) merged.api_key = cur.api_key;
  setConfig(AI_CONFIG_KEY, JSON.stringify(merged));
}
// AI 调度状态：last_run_ts 防同日重复、进程重启后从 DB 恢复；last_status/last_error 供前端展示。
function getAiState() {
  // last_duration_ms：最近一次生成耗时（ms），落库以便跨进程重启后仍能在前端展示
  const def = { last_run_ts: 0, last_status: 'idle', last_error: '', last_duration_ms: 0 };
  try {
    const o = JSON.parse(getConfig(AI_STATE_KEY) || '{}');
    return Object.assign(def, o);
  } catch (e) { return def; }
}
function setAiState(s) { setConfig(AI_STATE_KEY, JSON.stringify(s)); }

// ---- 数据库备份状态（宿主侧 diting.sh 执行后回写，供后台「备份监控」展示）----
// 刻意存独立键而非放进 ui_settings：前端保存设置时是整体覆盖写 ui_settings，
// 若放那里会被未 clone 该字段的提交抹掉。
function getBackupState() {
  const def = {
    last_run_ts: 0,          // 最近一次备份完成时间（ms）
    last_status: 'unknown',  // ok / failed / skipped / unknown
    last_file: '',           // 备份文件名
    last_size_bytes: 0,      // 备份后体积（字节，压缩后）
    last_raw_bytes: 0,       // 备份前体积（字节，未压缩）
    last_duration_ms: 0,
    last_error: '',
    last_pruned: 0,          // 本次清理掉的过期备份数
    backup_count: 0,         // 当前保留的备份份数
    total_bytes: 0,          // 备份目录占用（字节）
    updated_at: 0
  };
  try {
    const o = JSON.parse(getConfig(BACKUP_STATE_KEY) || '{}');
    return Object.assign(def, o);
  } catch (e) { return def; }
}
function setBackupState(s) {
  const merged = Object.assign(getBackupState(), s || {}, { updated_at: Date.now() });
  setConfig(BACKUP_STATE_KEY, JSON.stringify(merged));
}

// ---- F8.6：恢复后一致性审查 ----
// diting.sh 在替换数据库前把 restore_audit_pending 写进「即将生效」的库；
// 服务启动时读到它就跑一次审查（src/restore-audit.js），完成后清标记、
// 把报告写入 restore_audit_last（备份页「最近一次恢复审查」面板读它）。
const RESTORE_AUDIT_PENDING_KEY = 'restore_audit_pending';
const RESTORE_AUDIT_LAST_KEY = 'restore_audit_last';

function parseJsonConfig(key) {
  try {
    const o = JSON.parse(getConfig(key) || 'null');
    return o && typeof o === 'object' ? o : null;
  } catch (e) { return null; }
}
function getRestoreAuditPending() { return parseJsonConfig(RESTORE_AUDIT_PENDING_KEY); }
function setRestoreAuditPending(v) { setConfig(RESTORE_AUDIT_PENDING_KEY, JSON.stringify(v || {})); }
function clearRestoreAuditPending() { deleteConfig(RESTORE_AUDIT_PENDING_KEY); }
function getRestoreAuditReport() { return parseJsonConfig(RESTORE_AUDIT_LAST_KEY); }
function setRestoreAuditReport(r) { setConfig(RESTORE_AUDIT_LAST_KEY, JSON.stringify(r || {})); }

// ---- AI 报告 CRUD ----
function insertAiReport(r) {
  const info = stmts.insertAiReport.run({
    period: r.period || '',
    risk_level: r.risk_level || '',
    summary: r.summary || '',
    suggestion: r.suggestion || '',
    report_json: r.report_json || '',
    prompt_version: r.prompt_version || '',
    created_at: r.created_at || Date.now(),
    prompt_tokens: Number(r.prompt_tokens) || 0,
    completion_tokens: Number(r.completion_tokens) || 0,
    total_tokens: Number(r.total_tokens) || 0,
    duration_ms: Number(r.duration_ms) || 0,
    degraded: r.degraded ? 1 : 0
  });
  return stmts.getAiReport.get(info.lastInsertRowid);
}
function getAiReport(id) { return stmts.getAiReport.get(id); }
function listAiReports(limit, offset) {
  return stmts.listAiReports.all(Math.max(1, Number(limit) || 20), Math.max(0, Number(offset) || 0));
}
function countAiReports() { return stmts.countAiReports.get().n; }
// AI 用量按日聚合（返回 [{ day: 天序号, reports, prompt_tokens, completion_tokens, total_tokens }]）
function aiUsageDaily(sinceTs) { return stmts.aiUsageDaily.all(sinceTs); }

// 纳入 prune：按保留天数同步清理历史 AI 报告（与 metrics 清理同周期）。
function pruneAiReports(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  return stmts.pruneAiReports.run(cutoff).changes;
}

// ---- AI 单节点报告（§8 T17）----
// 只在「真实调用模型并成功」时落库；缓存命中不落（否则同一次结果会反复写历史）。
function insertAiNodeReport(r) {
  const info = stmts.insertAiNodeReport.run({
    agent_id: String(r.agent_id || ''),
    period_hours: Number(r.period_hours) || 24,
    status: r.status || 'ok',
    risk_level: r.risk_level || '',
    report_json: r.report_json || '',
    prompt_version: r.prompt_version || '',
    created_at: r.created_at || Date.now(),
    prompt_tokens: Number(r.prompt_tokens) || 0,
    completion_tokens: Number(r.completion_tokens) || 0,
    total_tokens: Number(r.total_tokens) || 0,
    duration_ms: Number(r.duration_ms) || 0
  });
  return info.lastInsertRowid;
}
function listAiNodeReports(agentId, limit) {
  const n = Math.max(1, Math.min(50, Number(limit) || 10));
  return stmts.listAiNodeReports.all(String(agentId), n);
}
function pruneAiNodeReports(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  return stmts.pruneAiNodeReports.run(cutoff).changes;
}

// ---- 审计日志 ----
const insertAuditLog = db.prepare(`INSERT INTO audit_logs (ts, admin, ip, action, detail, via)
  VALUES (@ts, @admin, @ip, @action, @detail, @via)`);
const listAuditLogs = db.prepare('SELECT * FROM audit_logs ORDER BY ts DESC LIMIT ? OFFSET ?');
const countAuditLogs = db.prepare('SELECT COUNT(*) AS n FROM audit_logs');
const pruneAuditLogs = db.prepare('DELETE FROM audit_logs WHERE ts < ?');

function addAuditLog(ts, admin, ip, action, detail, via) {
  insertAuditLog.run({ ts, admin, ip, action, detail: detail || '', via: via || '' });
}
function getAuditLogs(limit, offset) {
  return listAuditLogs.all(Math.max(1, Number(limit) || 100), Math.max(0, Number(offset) || 0));
}
function countAudit() { return countAuditLogs.get().n; }
function pruneAudit(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  return pruneAuditLogs.run(cutoff).changes;
}

// 数据库文件大小（字节）。含主库文件 + rollback-journal（写入中暂存的 -journal），不含 WAL/SHM
//（本应用刻意不用 WAL 模式）。用于后台仪表盘展示数据库占用监控。
function getDbFileSize() {
  let size = 0;
  for (const p of [DB_PATH, `${DB_PATH}-journal`]) {
    try { size += fs.statSync(p).size; } catch (_) { /* 文件不存在则忽略 */ }
  }
  return size;
}

// ---- S5/F10：主题市场源 ----------------------------------------------------
const genThemeSourceId = () => 'src_' + crypto.randomBytes(6).toString('hex');
const marketSourceOut = (r) => ({
  id: r.id, name: r.name, url: r.url, enabled: !!r.enabled,
  created_at: r.created_at, updated_at: r.updated_at
});

const listThemeMarketSources = () =>
  db.prepare('SELECT * FROM theme_market_sources ORDER BY created_at ASC').all().map(marketSourceOut);

const getThemeMarketSource = (id) => {
  const r = db.prepare('SELECT * FROM theme_market_sources WHERE id = ?').get(String(id));
  return r ? marketSourceOut(r) : null;
};

/** 幂等创建：url 已存在时返回已有行（不覆盖管理员改过的 name/enabled）。 */
function createThemeMarketSource({ name, url, enabled = true }) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM theme_market_sources WHERE url = ?').get(String(url));
  if (existing) return marketSourceOut(existing);
  const id = genThemeSourceId();
  db.prepare(`INSERT INTO theme_market_sources (id, name, url, enabled, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, String(name).slice(0, 64), String(url), enabled ? 1 : 0, now, now);
  return getThemeMarketSource(id);
}

function updateThemeMarketSource(id, patch = {}) {
  const cur = getThemeMarketSource(id);
  if (!cur) return null;
  const next = {
    name: patch.name !== undefined ? String(patch.name).slice(0, 64) : cur.name,
    url: patch.url !== undefined ? String(patch.url) : cur.url,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (cur.enabled ? 1 : 0)
  };
  db.prepare('UPDATE theme_market_sources SET name = ?, url = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(next.name, next.url, next.enabled, Date.now(), String(id));
  return getThemeMarketSource(id);
}

const deleteThemeMarketSource = (id) =>
  db.prepare('DELETE FROM theme_market_sources WHERE id = ?').run(String(id)).changes > 0;

// 官方源种子。仓库已上线（fengzone85/diting-theme-market）并已收录首个主题，默认启用。
const OFFICIAL_THEME_MARKET = {
  id: 'official',
  name: 'Diting Official',
  url: 'https://raw.githubusercontent.com/fengzone85/diting-theme-market/main/v1.json',
  enabled: true
};
function seedThemeMarketSources() {
  try {
    const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO theme_market_sources (id, name, url, enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(OFFICIAL_THEME_MARKET.id, OFFICIAL_THEME_MARKET.name, OFFICIAL_THEME_MARKET.url,
        OFFICIAL_THEME_MARKET.enabled ? 1 : 0, now, now);
  } catch (e) { /* 种子失败不应阻塞启动（如历史库已有同 URL 的自定义源） */ }
}

// ---- S5/F10：主题配置值（admin_config key-value，键名 theme_config_<short>）----
const THEME_CONFIG_PREFIX = 'theme_config_';
const getThemeConfig = (short) => {
  try { return JSON.parse(getConfig(THEME_CONFIG_PREFIX + String(short)) || '{}') || {}; }
  catch (e) { return {}; }
};
const setThemeConfig = (short, obj) => setConfig(THEME_CONFIG_PREFIX + String(short), JSON.stringify(obj || {}));
const deleteThemeConfig = (short) =>
  db.prepare('DELETE FROM admin_config WHERE key = ?').run(THEME_CONFIG_PREFIX + String(short)).changes > 0;

seedThemeMarketSources();

module.exports = {
  db, DB_PATH, getDbFileSize, hashToken, genToken,
  createAgent, getAgent, getAgents, getMonitoredAgents, approveAgent,
  listDeletedAgents, getAgentIncludingDeleted, restoreAgent, purgeDeletedAgents,
  getSelfRegisteredCount, bumpSelfRegisteredCount, updateAgent, deleteAgent, resetAgentToken,
  touchAgent, setAgentCores, insertMetric, getLatestMetric, getMetricsSampled, getMetricsProbesOne,
  getRecentMetrics, trafficEstimateBucketed, accumulateTraffic, flushTraffic, hasTrafficCounter,
  getMetricsLoadOne, getMetricsLoadAll, countActiveAgents,
  // metricsSparklinesAllSampled 是活函数（api.js + ai/summarizer.js 共 4 处），勿随 metricsSparklinesAll 一并删除。
  getMetricsSparklines, getMetricsSparklinesOne, metricsSparklinesAllSampled, metricsProbesAll, metricsClusterAvg, metricsDiskTrendAll,
  prune, getAlertState, setAlertState, clearAlertState,
  getAlertOverride, listAlertOverrides, upsertAlertOverride, deleteAlertOverride,
  getGroupAlertOverride, listGroupAlertOverrides, upsertGroupAlertOverride, deleteGroupAlertOverride,
  ALERT_OVERRIDE_KEYS, ALERT_OVERRIDE_LIMITS,
  listNotifyChannels, getNotifyChannel, createNotifyChannel, updateNotifyChannel, deleteNotifyChannel,
  listNotifyGroups, getNotifyGroup, createNotifyGroup, updateNotifyGroup, deleteNotifyGroup,
  listEnabledChannelsForEvent, initNotifyMigrationIfNeeded,
  createApiToken, findApiTokenByHash, getApiToken, listApiTokens, revokeApiToken, touchApiToken,
  createSessionRow, getSessionRow, listSessions, revokeSession, revokeAllSessionRows, revokeAllSessionRowsExcept, pruneSessions, touchSession,
  heavyQuerySync,
  getConfig, setConfig, setConfigIfAbsent, deleteConfig, get2FASecret, is2FAEnabled, set2FASecret, set2FAEnabled,
  getAdminTokenHash, setAdminTokenHash, setAdminTokenHashIfAbsent, clearAdminTokenHash,
  getSetupToken, setSetupToken, clearSetupToken,
  isSetupTokenCleared, markSetupTokenCleared, unmarkSetupTokenCleared,
  resolveAlertThresholds, observedIntervalSec,
  getUiSettings, setUiSettings, getNotifyConfig, setNotifyConfig, getRetentionDays,
  getAiConfig, setAiConfig, getAiState, setAiState,
  getBackupState, setBackupState,
  markTrafficGap,
  backupTo,
  getRestoreAuditPending, setRestoreAuditPending, clearRestoreAuditPending,
  getRestoreAuditReport, setRestoreAuditReport,
  listThemeMarketSources, getThemeMarketSource, createThemeMarketSource, updateThemeMarketSource,
  deleteThemeMarketSource, OFFICIAL_THEME_MARKET,
  getThemeConfig, setThemeConfig, deleteThemeConfig,
  insertAiReport, getAiReport, listAiReports, countAiReports, pruneAiReports, aiUsageDaily,
  insertAiNodeReport, listAiNodeReports, pruneAiNodeReports,
  addAuditLog, getAuditLogs, countAudit, pruneAudit
};
