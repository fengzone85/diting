'use strict';
// 迁移公用工具：只读探测列 + 幂等补列。
// 表名 / 列名 / 类型全部由迁移文件硬编码（不接受外部输入），这里仍做一次标识符校验，
// 因为这些值会被拼进 PRAGMA / ALTER 语句（SQLite 不支持对标识符参数化）。

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkIdent(name, kind) {
  if (!IDENT.test(String(name))) throw new Error(`非法${kind}标识符: ${name}`);
  return name;
}

// 读取表的现有列名（PRAGMA 只读，不产生写入）。
function columns(db, table) {
  checkIdent(table, '表名');
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function hasColumn(db, table, col) {
  return columns(db, table).includes(col);
}

// 幂等补列：cols 为 [列名, 类型定义] 数组；已存在的列跳过。
// 只增不删——迁移永远不做 DROP / DELETE。
function addColumnsIfMissing(db, table, cols) {
  const existing = new Set(columns(db, table));
  for (const [col, type] of cols) {
    checkIdent(col, '列名');
    if (!existing.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`);
  }
}

module.exports = { columns, hasColumn, addColumnsIfMissing };
