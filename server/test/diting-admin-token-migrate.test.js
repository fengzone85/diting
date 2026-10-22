'use strict';
// ============================================================
// 行为测试：diting.sh 的 migrate_env_admin_token（D7 的落地件）
//
// 真实执行函数体（不是文本断言）：造一个宿主库 + 一份含明文 ADMIN_TOKEN 的 .env，
// 跑迁移后断言「库中出现 sha256 哈希、明文不在任何命令行参数里、重复跑幂等」。
// 这是删掉 compose `ADMIN_TOKEN=` 之后，存量实例不掉进"未安装"态的唯一保障。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'diting.sh');
const SERVER_DIR = path.join(__dirname, '..');
const src = fs.readFileSync(SCRIPT, 'utf8');

function fnBody(name) {
  const start = src.indexOf(`\n${name}() {`);
  assert.notStrictEqual(start, -1, `diting.sh 应包含 ${name}() 定义`);
  const end = src.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `未能定位 ${name}() 的函数体结尾`);
  return src.slice(start + 1, end + 3);
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-mig-'));
  const dbPath = path.join(dir, 'monitor.db');
  const envPath = path.join(dir, 'server', '.env');
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  // db_run_js 的宿主机分支靠 server_node_modules 找依赖；scratch 里软链一份，
  // 让被测路径（SRC_DIR/server/node_modules）真实命中，而不是绕道回退。
  const nm = path.join(SERVER_DIR, 'node_modules');
  if (fs.existsSync(path.join(nm, 'better-sqlite3'))) {
    fs.symlinkSync(nm, path.join(dir, 'server', 'node_modules'));
  }
  // 用服务端依赖建一张空库（admin_config 表），模拟"服务端已初始化过"的存量实例
  execSync(`node -e "const D=require('better-sqlite3');const db=new D('${dbPath}');db.exec('CREATE TABLE IF NOT EXISTS admin_config (key TEXT PRIMARY KEY, value TEXT)');db.close()"`, {
    cwd: SERVER_DIR, encoding: 'utf8',
  });
  return { dir, dbPath, envPath };
}

function runMigrate(dir, dbPath) {
  const script = `
SRC_DIR="${dir}"
RED=''; GREEN=''; NC=''
${fnBody('server_node_modules')}
${fnBody('db_run_js')}
${fnBody('migrate_env_admin_token')}
locate_db() { echo "file:${dbPath}"; }
migrate_env_admin_token
`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: dir });
}

const TOKEN = 'migrate-plain-token-7Kq2Xz9Rp4Wm';

test('行为：.env 明文 ADMIN_TOKEN → 库中 sha256 哈希', () => {
  const { dir, dbPath, envPath } = setup();
  fs.writeFileSync(envPath, `PORT=8081\nADMIN_TOKEN=${TOKEN}\nSESSION_SECRET=x\n`);
  const r = runMigrate(dir, dbPath);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /已把 \.env 的管理员 Token 迁入数据库/, '应打印迁移成功');

  const db = require(path.join(SERVER_DIR, 'src', 'db'));
  const D = require('better-sqlite3');
  const row = new D(dbPath).prepare("SELECT value FROM admin_config WHERE key='admin_token_hash'").get();
  assert.ok(row, '库中应出现 admin_token_hash');
  assert.strictEqual(row.value, crypto.createHash('sha256').update(TOKEN).digest('hex'));
  assert.ok(!r.stdout.includes(TOKEN), '迁移过程的输出不得出现明文');
});

test('行为：重复迁移幂等（库已有哈希时跳过，不覆盖）', () => {
  const { dir, dbPath, envPath } = setup();
  fs.writeFileSync(envPath, `ADMIN_TOKEN=${TOKEN}\n`);
  const first = runMigrate(dir, dbPath);
  assert.strictEqual(first.status, 0, first.stderr);
  const D = require('better-sqlite3');
  const before = new D(dbPath).prepare("SELECT value FROM admin_config WHERE key='admin_token_hash'").get().value;
  // 换成另一个明文再跑：不得覆盖既有哈希
  fs.writeFileSync(envPath, `ADMIN_TOKEN=another-token-8Yr3Bp6Lq1Wd\n`);
  const second = runMigrate(dir, dbPath);
  assert.strictEqual(second.status, 0, second.stderr);
  const after = new D(dbPath).prepare("SELECT value FROM admin_config WHERE key='admin_token_hash'").get().value;
  assert.strictEqual(after, before, '库已有哈希时应原样跳过');
  assert.doesNotMatch(second.stdout, /已把 \.env 的管理员 Token 迁入数据库/, '第二次不应再打印迁移成功');
});

test('行为：空 ADMIN_TOKEN / 过短占位符 / 无 .env → 不写库', () => {
  const cases = [null, '', 'placeholder'];
  for (const v of cases) {
    const { dir, dbPath, envPath } = setup();
    if (v !== null) fs.writeFileSync(envPath, `ADMIN_TOKEN=${v}\n`);
    const r = runMigrate(dir, dbPath);
    assert.strictEqual(r.status, 0, r.stderr);
    const D = require('better-sqlite3');
    const row = new D(dbPath).prepare("SELECT value FROM admin_config WHERE key='admin_token_hash'").get();
    assert.ok(!row, `ADMIN_TOKEN=${JSON.stringify(v)} 不应写入哈希（交给 /install 生成）`);
  }
});
