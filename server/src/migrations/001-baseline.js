'use strict';
// 001 基线：历史冻结快照。
// 内容原样取自 B 批之前 db.js 的建表块（21 张业务表 + 全部索引），刻意不做「补全」：
// 部分老表（如 metrics）建表时不含后来追加的列，收敛到现网 schema 由 002–006 完成。
// 这样 001 保持「当年发布时的样子」，后续列变更有据可查。

const { CREATE_METRICS_SQL } = require('../metric-schema');

const BASELINE_SQL = `
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

-- 列片段由 metric-schema.js 生成（baseline:true 的列，按声明序）；
-- 索引/表选项/外键仍手写，避免把非列语义塞进生成器。
CREATE TABLE IF NOT EXISTS metrics (
${CREATE_METRICS_SQL}
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_metrics_agent_ts ON metrics(agent_id, ts);
-- 全量 sparklines 查询（WHERE ts>=? 无 agent_id 条件）需要单列 ts 索引，避免 7d 窗口全表扫描
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);

-- 小时级历史（S2）：由 rollup 任务从 metrics 折叠而来，保留期 = RETENTION_DAYS。
-- 明细只保留 METRICS_DETAIL_DAYS（默认 7 天），长窗口查询走「小时行 + 明细行」合并读。
-- 刻意不声明 FOREIGN KEY：purgeDeletedAgents() 显式清理（S2.4 / F11 约定）。
CREATE TABLE IF NOT EXISTS metrics_hour (
  agent_id   TEXT NOT NULL,
  hour_ts    INTEGER NOT NULL,
  n          INTEGER NOT NULL,
  cpu_avg REAL,          cpu_max REAL,
  mem_pct_avg REAL,      mem_pct_max REAL,
  mem_used_avg INTEGER,  mem_total_avg INTEGER,
  disk_pct_avg REAL,     disk_pct_max REAL,
  disk_used_avg INTEGER, disk_total_avg INTEGER,
  load1_avg REAL,        load1_max REAL,
  load5_avg REAL,        load15_avg REAL,
  net_rx_rate_avg REAL,  net_rx_rate_max REAL,
  net_tx_rate_avg REAL,  net_tx_rate_max REAL,
  net_rx_month INTEGER,  net_tx_month INTEGER,
  swap_pct_avg REAL,     swap_used_avg INTEGER, swap_total_avg INTEGER,
  uptime_avg REAL,
  temp_avg REAL,         temp_max REAL,
  disk_r_rate_max REAL,  disk_w_rate_max REAL,
  process_count_max INTEGER,
  probes_hour TEXT,
  PRIMARY KEY (agent_id, hour_ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_metrics_hour_ts ON metrics_hour(hour_ts);

CREATE TABLE IF NOT EXISTS alert_state (
  agent_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  last_sent  INTEGER NOT NULL,
  PRIMARY KEY(agent_id, type)
);

-- 告警规则覆盖（S1/F1）：NULL = 继承上层（分组 > 全局）。
-- 刻意不声明 FOREIGN KEY：不是「级联不执行」（better-sqlite3 11.x 默认已开
-- PRAGMA foreign_keys=ON，metrics/traffic_state 的 CASCADE 实测真实生效），而是
-- 主动选择「删除语义显式、可审计」——不给级联静默带走数据的机会。
-- 本表无 FK，由 purgeDeletedAgents()（软删到期）在同一事务里显式清理。
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

-- 在线时段（F7）：agents.last_seen 只有「最后一刻」，无法回答「过去 30 天在线率」。
-- 由 alerts.checkAgent 的在线判定派生（不改 agent 协议）：
--   ended_at IS NULL = 进行中；end_reason ∈ offline / pending / deleted / stale。
-- 同样刻意不声明 FOREIGN KEY：删除 agent 时由 deleteAgent() 同事务显式清理。
CREATE TABLE IF NOT EXISTS online_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  end_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_online_agent_start ON online_sessions(agent_id, started_at);
-- 同一 agent 最多一条进行中的 session：并发检查/崩溃重启时由唯一索引兜底，
-- 避免「两个 open session」把在线时长算成两倍。
CREATE UNIQUE INDEX IF NOT EXISTS idx_online_agent_open
  ON online_sessions(agent_id) WHERE ended_at IS NULL;

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

-- 组与渠道多对多。刻意不声明外键（删除语义显式化；better-sqlite3 默认 FK=ON），删除时由函数显式清理。
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

-- D 阶段：自定义受控端二进制 artifact（content-addressed 存储）。
-- 文件名完全由服务端按内容哈希生成（<sha256>.bin|.exe），**不使用任何用户输入** ⇒ 无路径穿越面；
-- sha256 唯一 ⇒ 同内容天然去重。
CREATE TABLE IF NOT EXISTS agent_artifacts (
  id          TEXT PRIMARY KEY,            -- 'art_' + 12 hex
  sha256      TEXT NOT NULL UNIQUE,        -- 内容哈希
  platform    TEXT NOT NULL,               -- linux-amd64 / windows-amd64 / ...
  filename    TEXT NOT NULL,               -- 磁盘文件名
  size        INTEGER NOT NULL,            -- 字节数
  source_note TEXT NOT NULL DEFAULT '',    -- 管理员备注（如 "my fork build 2026-10-25"）
  created_at  INTEGER NOT NULL
);

-- D 阶段：分发包元信息（包体落盘，库中只存索引与有效期）。
-- 一次性下载 token 不入库（内存 Map，用后即焚）；过期包可按 expires_at 清理。
CREATE TABLE IF NOT EXISTS agent_distributions (
  pkg_id      TEXT PRIMARY KEY,            -- 'pkg_' + 16 hex
  platform    TEXT NOT NULL,
  source_kind TEXT NOT NULL,               -- artifact | release_url
  source_ref  TEXT NOT NULL DEFAULT '',    -- artifact_id 或来源 URL（不含任何凭据）
  sha256      TEXT NOT NULL DEFAULT '',    -- 包内二进制的 sha256（空 = 包内不含二进制）
  filename    TEXT NOT NULL,               -- 磁盘文件名
  size        INTEGER NOT NULL,
  kind        TEXT NOT NULL,               -- tar.gz | zip
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_distributions_created ON agent_distributions(created_at DESC);

-- S2/F6 登录会话：cookie 内只带 sid，吊销状态以本表为准；
-- session_revoked_before 水位线保留为全局 kill switch。
-- 人用登录改造（r1/P0-2）：expires_at=会话到期（remember 长会话用；NULL=按旧 TTL 口径
-- 由 last_seen 决定）；remember=是否「受信任设备」长会话。prune 双条件见 pruneSessions。
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  admin      TEXT NOT NULL DEFAULT 'admin',
  ip         TEXT NOT NULL DEFAULT '',
  ua         TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  remember   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);

-- 一次性恢复码（2FA 备份因子）：只存 sha256(规范形)，消费即删行；
-- 明文仅生成时回显一次，不落库。
CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash  TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

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
  -- S1：受控端上报的接口集指纹（bootID/digest）。空 = 老 agent 或平台不支持。
  epoch       TEXT DEFAULT '',
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
`;

module.exports = {
  version: 1,
  name: 'baseline',
  up(db) {
    db.exec(BASELINE_SQL);
  },
};
