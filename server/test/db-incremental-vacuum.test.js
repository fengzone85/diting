'use strict';
// ============================================================
// 回归守卫：删除旧数据后要能把空闲页还给文件系统。
//
// 背景（方案附录 D.1）：本机生产库曾 1510MB，其中 96.4% 是 freelist —— 保留策略
// 每天 DELETE 旧指标，但 auto_vacuum=NONE 时删掉的页只登记在 freelist，文件只涨不缩。
//
// 现在：db.js 打开库时置位 auto_vacuum=INCREMENTAL（存量库需一次 VACUUM 生效），
// prune 删除后调 PRAGMA incremental_vacuum；`diting.sh --db-vacuum` 做一次性压缩。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', '..', 'diting.sh'), 'utf8');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-vac-'));
  return { dir, file: path.join(dir, 'monitor.db') };
}

function inflate(file, rows = 3000) {
  const db = new Database(file);
  db.pragma('auto_vacuum = INCREMENTAL');
  db.exec('CREATE TABLE IF NOT EXISTS t (a TEXT)');
  db.exec('VACUUM'); // auto_vacuum 置位后必须 VACUUM 才生效
  const ins = db.prepare('INSERT INTO t VALUES (?)');
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run('x'.repeat(200)); })();
  db.close();
}

test('INCREMENTAL + incremental_vacuum：删除后文件确实缩小', () => {
  const { dir, file } = tmpDb();
  try {
    inflate(file);
    const big = fs.statSync(file).size;

    const db = new Database(file);
    db.exec('DELETE FROM t');
    const free = db.pragma('freelist_count', { simple: true });
    assert.ok(free > 0, '删除后应产生空闲页');
    db.pragma('incremental_vacuum');
    db.close();

    const small = fs.statSync(file).size;
    assert.ok(small < big, `文件应缩小：${big} → ${small}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('对照组：auto_vacuum=NONE 时 incremental_vacuum 是 no-op（说明为何要改模式）', () => {
  const { dir, file } = tmpDb();
  try {
    const db0 = new Database(file);
    db0.exec('CREATE TABLE t (a TEXT)');
    const ins = db0.prepare('INSERT INTO t VALUES (?)');
    db0.transaction(() => { for (let i = 0; i < 3000; i++) ins.run('x'.repeat(200)); })();
    db0.close();
    const big = fs.statSync(file).size;

    const db = new Database(file);
    assert.strictEqual(db.pragma('auto_vacuum', { simple: true }), 0, '默认应为 NONE');
    db.exec('DELETE FROM t');
    db.pragma('incremental_vacuum'); // NONE 模式下不生效
    db.close();

    assert.ok(fs.statSync(file).size >= big * 0.9, '未启用增量回收时文件不会明显缩小');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db.js：打开库时置位 auto_vacuum，prune 后调用 incremental_vacuum', () => {
  assert.match(DB_JS, /pragma\('auto_vacuum = INCREMENTAL'\)/, '打开库应置位 INCREMENTAL');
  const pruneBody = DB_JS.slice(DB_JS.indexOf('const prune = ('), DB_JS.indexOf('const getAlertState'));
  assert.match(pruneBody, /db\.pragma\('incremental_vacuum'\)/, 'prune 删除后应做增量回收');
  assert.match(pruneBody, /if \(r\.changes > 0\)/, '仅在确有删除时才回收，避免空转');
});

test('diting.sh：--db-vacuum 已接入 usage / 解析 / 分发，且复用 db_run_js', () => {
  assert.match(SCRIPT, /--db-vacuum\)\s+ACTION="db-vacuum"/, '应解析 --db-vacuum');
  assert.match(SCRIPT, /db-vacuum\)\s+do_db_vacuum/, '应分发到 do_db_vacuum');
  assert.match(SCRIPT, /--db-vacuum\s+压缩数据库/, 'usage 应有说明');
  const start = SCRIPT.indexOf('do_db_vacuum() {');
  const body = SCRIPT.slice(start, SCRIPT.indexOf('\n}\n', start));
  assert.ok(start > -1, '应定义 do_db_vacuum');
  assert.match(body, /db_run_js/, '应复用 db_run_js（docker / 原生三分支）');
  assert.match(body, /auto_vacuum = INCREMENTAL/, '压缩时应顺带置位增量回收标志');
  assert.match(body, /db\.exec\('VACUUM'\)/, '应执行 VACUUM');
});
