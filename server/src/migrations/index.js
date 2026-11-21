'use strict';
// 迁移入口：按版本号升序执行，迁移记录（schema_migrations）与 DDL 同事务。
// 设计约定：
//   - 只增不删，不提供 downgrade（回滚靠 diting.sh --backup 的备份恢复）；
//   - 每个迁移单独一个事务，失败整体回滚且不写版本行，已成功的版本保留；
//   - 必须在 db.js 的预编译语句（const stmts）之前调用，否则语句会引用不存在的列。
const MIGRATIONS = [
  require('./001-baseline'),
  require('./002-metrics-columns'),
  require('./003-agents-columns'),
  require('./004-sessions-columns'),
  require('./005-traffic-state-epoch'),
  require('./006-ai-reports-usage'),
];

function runMigrations(db, now = Date.now()) {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );
  const pending = MIGRATIONS
    .filter((m) => !applied.has(m.version))
    .sort((a, b) => a.version - b.version);

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  const done = [];
  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      record.run(m.version, m.name, now);
    })();
    done.push(m.version);
  }
  return done;
}

module.exports = { MIGRATIONS, runMigrations };
