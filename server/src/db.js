const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// 数据库默认落盘位置：容器内若挂载了持久卷 /data（docker-compose 的 server-data），
// 则写入 /data/monitor.db，确保重建容器后数据仍在；否则回退到本地 server/data（开发/裸跑）。
const DB_PATH = process.env.DB_PATH || (() => {
  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) return '/data/monitor.db';
  } catch (e) {}
  return path.join(__dirname, '..', 'data', 'monitor.db');
})();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// 负载曲线列集（不含 probes / disks 大字段），供 metricsLoadOne / metricsLoadAll 复用
const LOAD_COLS = `ts, agent_id, cpu, mem_used, mem_total, mem_pct, load1, load5, load15,
  net_rx_rate, net_tx_rate, net_rx_month, net_tx_month, disk_used, disk_total,
  disk_r_rate, disk_w_rate, swap_used, swap_total, swap_pct, temp`;

const db = new Database(DB_PATH);
// 收紧数据库文件权限：仅属主可读写（默认 umask 常为 644，其他用户可读）。
// 库内虽无指纹指标，但含全部监控数据，按最小权限原则限制暴露面。
try { fs.chmodSync(DB_PATH, 0o600); } catch (e) { /* 某些挂载文件系统不支持 chmod，忽略 */ }
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
  getAgent: db.prepare('SELECT * FROM agents WHERE id = ?'),
  getAgents: db.prepare('SELECT * FROM agents ORDER BY created_at DESC'),
  insertAgent: db.prepare(`INSERT INTO agents
    (id, name, token_hash, merchant, note, expire_at, monthly_quota_gb, price, billing_cycle, currency, auto_renewal, grp, country, probe_targets, created_at, last_seen)
    VALUES (@id, @name, @token_hash, @merchant, @note, @expire_at, @monthly_quota_gb, @price, @billing_cycle, @currency, @auto_renewal, @grp, @country, @probe_targets, @created_at, 0)`),
  updateAgent: db.prepare(`UPDATE agents SET
    name=@name, merchant=@merchant, note=@note, expire_at=@expire_at, monthly_quota_gb=@monthly_quota_gb,
    price=@price, billing_cycle=@billing_cycle, currency=@currency, auto_renewal=@auto_renewal,
    grp=@grp, country=@country, probe_targets=@probe_targets
    WHERE id=@id`),
  deleteAgent: db.prepare('DELETE FROM agents WHERE id = ?'),
  touch: db.prepare('UPDATE agents SET last_seen=?, os=?, hostname=? WHERE id=?'),
  insertMetric: db.prepare(`INSERT INTO metrics
    (agent_id, ts, cpu, mem_used, mem_total, mem_pct, disk_used, disk_total, disk_pct,
     load1, load5, load15, net_rx_rate, net_tx_rate, net_rx_month, net_tx_month, uptime,
     temp, swap_used, swap_total, swap_pct, disk_r_rate, disk_w_rate, probes, disks)
    VALUES (@agent_id, @ts, @cpu, @mem_used, @mem_total, @mem_pct, @disk_used, @disk_total, @disk_pct,
     @load1, @load5, @load15, @net_rx_rate, @net_tx_rate, @net_rx_month, @net_tx_month, @uptime,
     @temp, @swap_used, @swap_total, @swap_pct, @disk_r_rate, @disk_w_rate, @probes, @disks)`),
  // 窗口内实际有数据的节点数（用于历史接口的每节点点数分摊）
  countActiveAgents: db.prepare('SELECT COUNT(DISTINCT agent_id) AS c FROM metrics WHERE ts>=?'),
  latestMetric: db.prepare('SELECT * FROM metrics WHERE agent_id=? ORDER BY ts DESC LIMIT 1'),
  metricsRange: db.prepare('SELECT * FROM metrics WHERE agent_id=? AND ts>=? ORDER BY ts ASC'),
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
  metricsLoadOne: (agentId, sinceTs, maxPoints) => {
    const step = Math.max(1, Math.floor(Number(maxPoints) || 1));
    return db.prepare(`
      WITH numbered AS (
        SELECT ${LOAD_COLS},
               ROW_NUMBER() OVER (ORDER BY ts ASC) AS rn,
               COUNT(*) OVER () AS cnt
        FROM metrics WHERE agent_id=@agentId AND ts>=@since
      )
      SELECT ${LOAD_COLS} FROM numbered
      WHERE rn = 1 OR rn = cnt OR rn % MAX(1, CAST(cnt/CAST(@step AS INTEGER) AS INTEGER)) = 0
      ORDER BY ts ASC`).all({ agentId, since: sinceTs, step });
  },
  // 跨节点版本：按「时间桶 + 取桶内最早一行」采样（每节点约 maxPoints 点）。
  // 不用窗口函数：实测 720h 全库（191 万行）窗口版 23.6s，分桶版 2.2s——
  // 窗口函数要把整段匹配行进临时 B-TREE 排序两遍（ROW_NUMBER 分区 + 最终 ORDER BY），
  // 分桶只做一次覆盖索引扫描 + 分组（同样保留首尾桶，不丢首尾点语义）。
  metricsLoadAll: (sinceTs, maxPoints) => {
    const bucket = Math.max(1, Math.floor((Date.now() - sinceTs) / Math.max(1, Number(maxPoints) || 1)));
    return db.prepare(`
      SELECT ${LOAD_COLS.replace(/\b(ts|agent_id)\b/g, 'm.$1')} FROM metrics m
      JOIN (
        SELECT agent_id, MIN(ts) AS ts
        FROM metrics WHERE ts>=@since
        GROUP BY agent_id, CAST((ts - @since) / CAST(@bucket AS INTEGER) AS INTEGER)
      ) k ON m.agent_id = k.agent_id AND m.ts = k.ts
      ORDER BY m.agent_id, m.ts ASC`).all({ since: sinceTs, bucket });
  },
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
  resetToken: db.prepare('UPDATE agents SET token_hash=? WHERE id=?'),
  metricsRangeAll: db.prepare('SELECT * FROM metrics WHERE ts>=? ORDER BY agent_id, ts ASC'),
  // 磁盘趋势专用：跨所有 agent 按时间桶取 disk_pct 均值。
  // 只取三列、单次扫描、无窗口函数；**必须输出 MIN(ts) AS ts** —— 若只返回桶号，
  // 调用方用 last.ts - first.ts 求跨度会得到 NaN → 趋势分析静默失效。
  // 复刻 metricsClusterAvg 的 CAST 整数地板除法：绑定 number 会被 better-sqlite3 绑成 REAL，
  // 浮点除法会让每个值自成一组。
  metricsDiskTrendAll: (sinceTs, bucketMs) => db.prepare(`
    SELECT agent_id,
           MIN(ts) AS ts,
           AVG(disk_pct) AS pct
    FROM metrics
    WHERE ts >= @since AND disk_pct IS NOT NULL
    GROUP BY agent_id, CAST((ts - @since) / CAST(@bucket AS INTEGER) AS INTEGER)
    ORDER BY agent_id, ts`).all({ since: sinceTs, bucket: Math.max(1, bucketMs) }),
  // sparklines 只需要指标列（不含 probes 大字段）：单节点 30d 由 5.3s 降到 2.3s
  metricsSparklines: db.prepare('SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate, load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total FROM metrics WHERE agent_id=? AND ts>=? ORDER BY ts ASC'),
  metricsSparklinesAll: db.prepare('SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate, load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total FROM metrics WHERE ts>=? ORDER BY agent_id, ts ASC'),
  // 全量 sparklines SQL 层采样：窗口函数按 agent 分组，每 agent 最多保留 maxPoints 点（首尾+均匀间隔）。
  // 7d 窗口 757K 行→~7200 行（减少 100x 传输+JS 处理），max_points 由 clampInt 钳为整数故安全内插。
  metricsSparklinesAllSampled: (sinceTs, maxPoints) => {
    const step = Math.max(1, Math.floor(Number(maxPoints) || 1));
    return db.prepare(`
      WITH numbered AS (
        SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate,
               load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total,
               ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ts ASC) AS rn,
               COUNT(*) OVER (PARTITION BY agent_id) AS cnt
        FROM metrics WHERE ts>=@since
      )
      SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate,
             load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total
      FROM numbered
      WHERE rn = 1 OR rn = cnt OR rn % MAX(1, CAST(cnt/CAST(@step AS INTEGER) AS INTEGER)) = 0
      ORDER BY agent_id, ts ASC`).all({ since: sinceTs, step });
  },
  // 单节点 sparklines SQL 层采样（节点详情页专用）：与全量版同构，但按 agent_id 过滤。
  // 此前详情页单节点走「全量拉取 10.8 万行 → Node 侧 downsampleSparklines 降到 2000 点」，
  // 每次请求 2.77s + 220MB 峰值，30s 缓存一过就卡/偶发超时。SQL 层直接只返回 maxPoints 行。
  // 必须保留首尾点（rn=1 OR rn=cnt）：详情页磁盘耗尽预测依赖 disk_used 首末值做线性外推。
  metricsSparklinesOne: (agentId, sinceTs, maxPoints) => {
    const step = Math.max(1, Math.floor(Number(maxPoints) || 1));
    return db.prepare(`
      WITH numbered AS (
        SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate,
               load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total,
               ROW_NUMBER() OVER (ORDER BY ts ASC) AS rn,
               COUNT(*) OVER () AS cnt
        FROM metrics WHERE agent_id=@agentId AND ts>=@since
      )
      SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate,
             load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total
      FROM numbered
      WHERE rn = 1 OR rn = cnt OR rn % MAX(1, CAST(cnt/CAST(@step AS INTEGER) AS INTEGER)) = 0
      ORDER BY ts ASC`).all({ agentId, since: sinceTs, step });
  },
  // 集群级时间桶聚合（仪表盘平均 CPU/内存趋势专用）：跨所有 agent 按固定时间桶 GROUP BY，
  // 直接算出每个桶的 cpu/mem 平均值。返回行数=桶数（≤maxPoints），彻底规避「62 台 × 每 agent 2000 点
  // 全量拉到前端再逐点聚合」的主线程卡顿。SQL 引擎做聚合，只传输最终曲线。
  // spanMs: 窗口总时长（毫秒），用于按目标点数反推桶宽 = spanMs/maxPoints。
  // 注意：better-sqlite3 对绑定对象里的 number 默认绑成 REAL，导致 (ts-@since)/@bucket 变浮点除法、
  // 每个浮点值自成一组。故用 CAST(... AS INTEGER) 强制整数地板除法，保证分组数≈maxPoints。
  metricsClusterAvg: (sinceTs, spanMs, maxPoints) => {
    const bucket = Math.max(1, Math.ceil(spanMs / Math.max(1, maxPoints)));
    return db.prepare(`
      WITH agg AS (
        SELECT CAST((ts - @since) / @bucket AS INTEGER) AS b,
               AVG(cpu) AS cpu, AVG(mem_pct) AS mem_pct
        FROM metrics WHERE ts>=@since AND cpu IS NOT NULL
        GROUP BY b
      )
      SELECT (@since + CAST(b AS INTEGER) * @bucket) AS ts, cpu, mem_pct
      FROM agg ORDER BY b ASC`).all({ since: sinceTs, bucket });
  },
  // ---- AI 报告 ----
  insertAiReport: db.prepare(`INSERT INTO ai_reports
    (period, risk_level, summary, suggestion, report_json, prompt_version, created_at,
     prompt_tokens, completion_tokens, total_tokens, duration_ms, degraded)
    VALUES (@period, @risk_level, @summary, @suggestion, @report_json, @prompt_version, @created_at,
     @prompt_tokens, @completion_tokens, @total_tokens, @duration_ms, @degraded)`),
  getAiReport: db.prepare('SELECT * FROM ai_reports WHERE id = ?'),
  listAiReports: db.prepare('SELECT id, period, risk_level, summary, suggestion, prompt_version, created_at FROM ai_reports ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  countAiReports: db.prepare('SELECT COUNT(*) AS n FROM ai_reports'),
  pruneAiReports: db.prepare('DELETE FROM ai_reports WHERE created_at < ?')
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
    created_at: Date.now()
  });
  return { id, token };
};

const getAgent = (id) => stmts.getAgent.get(id);
const getAgents = () => stmts.getAgents.all();
// 全量 sparklines SQL 层采样：窗口函数按 agent 分组，每 agent 最多保留 maxPoints 点。
const metricsSparklinesAllSampled = (sinceTs, maxPoints) => stmts.metricsSparklinesAllSampled(sinceTs, maxPoints);

// 集群级时间桶聚合（仪表盘平均曲线）：跨所有 agent 按时间桶求 cpu/mem 平均，返回行数≤maxPoints。
const metricsClusterAvg = (sinceTs, spanMs, maxPoints) => stmts.metricsClusterAvg(sinceTs, spanMs, maxPoints);

// 磁盘趋势：跨所有 agent 的桶聚合 disk_pct 序列（仅 ts/agent_id/disk_pct 三列），供 AI 日报趋势估计。
const metricsDiskTrendAll = (sinceTs, bucketMs) => stmts.metricsDiskTrendAll(sinceTs, bucketMs);

// 单节点 sparklines SQL 层采样（节点详情页）：只返回 maxPoints 行，保留首尾点供磁盘耗尽预测。
const getMetricsSparklinesOne = (agentId, sinceTs, maxPoints) => stmts.metricsSparklinesOne(agentId, sinceTs, maxPoints);

// 重置某 Agent 的 Token：生成新 token 并写入哈希，旧 token 立即失效。返回新明文 token。
const resetAgentToken = (id) => {
  const a = stmts.getAgent.get(id);
  if (!a) return null;
  const token = genToken();
  stmts.resetToken.run(hashToken(token), id);
  return token;
};
// 批量取所有 Agent 的时序指标（sparkline 用），按 agent_id 升序返回原始行。
const getMetricsAll = (sinceTs) => stmts.metricsRangeAll.all(sinceTs);

// 仅取 ts+probes 两列（探针延迟历史接口专用），规避 SELECT * 对全行列物化的开销。
const getMetricsProbes = (agentId, sinceTs) => stmts.metricsProbes.all(agentId, sinceTs);

// 单节点探针 SQL 层采样（详情页延迟波形）：只返回 maxPoints 行，规避 9.5 万次 JSON.parse。
const getMetricsProbesOne = (agentId, sinceTs, maxPoints) => stmts.metricsProbesOne(agentId, sinceTs, maxPoints);

// 全量探针：只取 ts/agent_id/probes 三列，并按 agent 时间桶降采样（每 agent 最多 maxPoints 点），
// 规避 SELECT * 物化全列 + 330 万行全量读进内存触发 OOM（see getMetricsAll 教训）。
const metricsProbesAll = (sinceTs, maxPoints) => {
  // 与 metricsLoadAll 同思路：改用「时间桶 + 桶内最早一行」替代窗口函数，
  // 720h 全库下从 ~16s 降到 ~2s，且同样保留首尾桶。
  const bucket = Math.max(1, Math.floor((Date.now() - sinceTs) / Math.max(1, Number(maxPoints) || 1)));
  return db.prepare(`
    SELECT m.ts, m.agent_id, m.probes FROM metrics m
    JOIN (
      SELECT agent_id, MIN(ts) AS ts
      FROM metrics WHERE ts>=@since AND probes IS NOT NULL
      GROUP BY agent_id, CAST((ts - @since) / CAST(@bucket AS INTEGER) AS INTEGER)
    ) k ON m.agent_id = k.agent_id AND m.ts = k.ts
    ORDER BY m.agent_id, m.ts ASC`).all({ since: sinceTs, bucket });
};

// sparkline 专用：只取指标列（不含 probes 大字段），规避 SELECT * 全行物化。
const getMetricsSparklines = (agentId, sinceTs) => stmts.metricsSparklines.all(agentId, sinceTs);
const getMetricsSparklinesAll = (sinceTs) => stmts.metricsSparklinesAll.all(sinceTs);

const updateAgent = (id, f) => stmts.updateAgent.run({
  id,
  name: f.name,
  merchant: f.merchant || '',
  note: f.note || '',
  expire_at: f.expire_at || '',
  monthly_quota_gb: Number(f.monthly_quota_gb) || 0,
  price: Number(f.price) || 0,
  billing_cycle: (f.billing_cycle === undefined || f.billing_cycle === null || f.billing_cycle === '' || isNaN(Number(f.billing_cycle))) ? 30 : Number(f.billing_cycle),
  currency: f.currency || '¥',
  auto_renewal: f.auto_renewal !== false ? 1 : 0,
  grp: f.grp || '',
  country: (f.country || '').toUpperCase().slice(0, 2),
  probe_targets: f.probe_targets || ''
});

const deleteAgent = (id) => {
  stmts.clearAllAlertState.run(id);
  return stmts.deleteAgent.run(id);
};

const touchAgent = (id, os, hostname) => stmts.touch.run(Date.now(), os || '', hostname || '', id);

const insertMetric = (agent_id, m) => stmts.insertMetric.run(Object.assign({ agent_id }, m));

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

const getMetrics = (agent_id, sinceTs) => stmts.metricsRange.all(agent_id, sinceTs);

const prune = (retentionDays) => {
  const cutoff = Date.now() - retentionDays * 86400000;
  const r = stmts.prune.run(cutoff);
  return r.changes;
};

const getAlertState = (agent_id, type) => stmts.getAlertState.get(agent_id, type);
const setAlertState = (agent_id, type, ts) => stmts.setAlertState.run(agent_id, type, ts);
const clearAlertState = (agent_id, type) => stmts.clearAlertState.run(agent_id, type);

// ---- Admin 2FA (TOTP) 配置（单管理员模型，key-value）----
const _getCfg = db.prepare('SELECT value FROM admin_config WHERE key = ?');
const _setCfg = db.prepare('INSERT OR REPLACE INTO admin_config (key, value) VALUES (?, ?)');
const _setCfgIfAbsent = db.prepare('INSERT OR IGNORE INTO admin_config (key, value) VALUES (?, ?)');
const TWOFA_SECRET = 'admin_2fa_secret';
const TWOFA_ENABLED = 'admin_2fa_enabled';
const getConfig = (k) => { const r = _getCfg.get(k); return r ? r.value : null; };
const setConfig = (k, v) => _setCfg.run(k, String(v));
// 仅当 key 不存在时写入（依赖 key 主键唯一性）。返回 true 表示本次写入成功。
// 用于 /api/setup/generate 防并发竞态：多个请求同时到达时只有一个能落库，其余返回 false。
const setConfigIfAbsent = (k, v) => _setCfgIfAbsent.run(k, String(v)).changes > 0;
const get2FASecret = () => getConfig(TWOFA_SECRET);
const is2FAEnabled = () => getConfig(TWOFA_ENABLED) === '1';
const set2FASecret = (s) => setConfig(TWOFA_SECRET, s);
const set2FAEnabled = (b) => setConfig(TWOFA_ENABLED, b ? '1' : '0');

// ---- UI / 通知设置（持久化到 admin_config 的 key-value）----
const SETTINGS_KEY = 'ui_settings';
const NOTIFY_KEY = 'notify_config';
function getUiSettings() {
  const def = { site_title: '', site_url: '', custom_css: '', default_sort: 'created', group_order: [], agent_server_url: '', admin_allow_ips: '', alert: { cpu_pct: 90, mem_pct: 90, offline_sec: 60 }, public_enabled: true,
    // 公开接口（/api/public/agents、/api/v1/nodes）是否透出业务字段：
    // 商家 merchant、到期 expire_at、备注 note、月流量配额 monthly_quota_gb、套餐 price/billing_cycle/currency。
    // 默认 true 与旧版行为一致（公开页首页「商家数/即将到期」与详情页「备注/套餐」依赖这些字段）；
    // 若公开页面向外部访客、不希望暴露经营信息，在后台设置里关闭即可，公开页会自动隐藏相关模块。
    public_show_business: true,
    home_layout: 'grid', public_theme: 'default', probe_targets: '移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8', retention_days: 30, social_email: '', social_telegram: '', social_qq: '', social_website: '',
    // 主题可视化配置（对齐 komari-theme-Glassmorphism）
    glass_preset: 'emerald',          // 毛玻璃配色预设：emerald/soft/high-contrast/midnight/custom
    glass_custom: {},                 // 自定义毛玻璃配色（light/dark 各 5 色）
    color_vision: 'normal',           // 色觉辅助：normal/protanopia/deuteranopia/tritanopia
    card_scheme: 'official',          // 首页总览卡片方案：official/basic/ops/resource/finance/traffic/gpu/asset/full
    card_size: 'comfortable',         // 节点卡片尺寸：mini/compact/comfortable/large
    background: { enabled: false, type: 'image', url: '', blur: 8, overlay: 50 }, // 背景图/视频
    announcement: { enabled: false, title: '', content: '' }, // 公告
    provider_aliases: {},             // 厂商别名映射 { "原始厂商": "显示名" }
    custom_tags: {},                  // 节点自定义标签 { "agent_id": "标签文本" }
    visitor_info: false               // 访客信息条（底部 IP 条）
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
    log_retention_days: 30        // AI 日报保留天数（与 metrics 保留期独立）
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
// 纳入 prune：按保留天数同步清理历史 AI 报告（与 metrics 清理同周期）。
function pruneAiReports(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  return stmts.pruneAiReports.run(cutoff).changes;
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

module.exports = {
  db, DB_PATH, getDbFileSize, hashToken, genToken,
  createAgent, getAgent, getAgents, updateAgent, deleteAgent, resetAgentToken,
  touchAgent, insertMetric, getLatestMetric, getMetrics, getMetricsSampled, getMetricsProbes, getMetricsProbesOne,
  getMetricsLoadOne, getMetricsLoadAll, countActiveAgents,
  getMetricsSparklines, getMetricsSparklinesAll, metricsSparklinesAllSampled, getMetricsAll, metricsProbesAll, metricsClusterAvg, metricsDiskTrendAll, getMetricsSparklinesOne,
  prune, getAlertState, setAlertState, clearAlertState,
  getConfig, setConfig, setConfigIfAbsent, get2FASecret, is2FAEnabled, set2FASecret, set2FAEnabled,
  getUiSettings, setUiSettings, getNotifyConfig, setNotifyConfig, getRetentionDays,
  getAiConfig, setAiConfig, getAiState, setAiState,
  insertAiReport, getAiReport, listAiReports, countAiReports, pruneAiReports,
  addAuditLog, getAuditLogs, countAudit, pruneAudit
};
