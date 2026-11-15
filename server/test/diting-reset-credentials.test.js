'use strict';
// ============================================================
// 回归守卫：diting.sh 人用登录改造相关的三个写库块
//   - purge_admin_credentials（卸载重装清凭据，r1/§3.6①：必须连密码/恢复码一起清）
//   - do_reset_admin_password（§3.6② 新增）
//   - do_reset_2fa（§3.7 终极破玻璃）
// 与 diting-reset-token.test.js 同款手法：提取内嵌 Node 事务在临时库上真实执行。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const SCRIPT = path.join(__dirname, '..', '..', 'diting.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

function fnBody(name) {
  const start = src.indexOf(`${name}() {`);
  assert.notStrictEqual(start, -1, `diting.sh 应包含 ${name}() 定义`);
  const end = src.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `未能定位 ${name}() 的函数体结尾`);
  return src.slice(start, end + 3);
}

function embeddedJs(body, label) {
  const m = body.match(/cat > "\$js" <<'JS'\n([\s\S]*?)\nJS\n/);
  assert.ok(m, `未能从 ${label} 中提取内嵌 JS`);
  return m[1];
}

function runJs(js, dbPath, ...args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-cred-'));
  const jsPath = path.join(dir, 'run.js');
  fs.writeFileSync(jsPath, js);
  const r = spawnSync('node', [jsPath, dbPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules') },
  });
  assert.strictEqual(r.status, 0, `执行内嵌 JS 失败：${r.stderr}`);
  return r.stdout;
}

function seedDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-cred-db-'));
  const dbPath = path.join(dir, 'monitor.db');
  const d = new Database(dbPath);
  d.exec(`
    CREATE TABLE admin_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE recovery_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER);
  `);
  const ins = d.prepare('INSERT OR REPLACE INTO admin_config(key,value) VALUES(?,?)');
  ins.run('session_revoked_before', '1');
  ins.run('admin_token_hash', 'f'.repeat(64));
  ins.run('admin_password_hash', 'scrypt$16384$8$1$aaa$bbb');
  ins.run('login_guard_global', '{"fails":2}');
  ins.run('admin_2fa_secret', 'JBSWY3DPEHPK3PXP');
  ins.run('admin_2fa_enabled', '1');
  ins.run('admin_token_raw', 'legacy');
  ins.run('admin_initialized', '1');
  d.prepare('INSERT INTO sessions(id) VALUES(?)').run('sess-a');
  d.prepare('INSERT INTO sessions(id) VALUES(?)').run('sess-b');
  const rc = d.prepare('INSERT OR REPLACE INTO recovery_codes(code_hash,created_at) VALUES(?,?)');
  for (let i = 0; i < 10; i++) rc.run('c'.repeat(8) + i, Date.now());
  d.close();
  fn(dbPath);
  return dbPath;
}

function readAll(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  const cfg = Object.fromEntries(d.prepare('SELECT key,value FROM admin_config').all().map((r) => [r.key, r.value]));
  const revoked = d.prepare('SELECT COUNT(*) n FROM sessions WHERE revoked=1').get().n;
  const codes = d.prepare('SELECT COUNT(*) n FROM recovery_codes').get().n;
  d.close();
  return { cfg, revoked, codes };
}

test('purge_admin_credentials：连密码/恢复码/失败桶一起清（r1/§3.6① 防凭据残留）', () => {
  const body = fnBody('purge_admin_credentials');
  const js = embeddedJs(body, 'purge_admin_credentials');
  assert.ok(js.includes('admin_password_hash'), 'purge 必须删 admin_password_hash');
  assert.ok(js.includes('login_guard_global'), 'purge 必须删登录失败桶');
  assert.ok(js.includes('recovery_codes'), 'purge 必须清 recovery_codes');
  assert.ok(/try\s*\{\s*db\.prepare\('DELETE FROM recovery_codes'\)/.test(js), 'recovery_codes 清理必须容错（表可能不存在）');
  // SQL 顺序：水位线 → 吊销 → 清键
  const order = ['session_revoked_before', 'UPDATE sessions SET revoked=1 WHERE revoked=0', 'admin_password_hash'];
  let last = -1;
  for (const frag of order) {
    const idx = js.indexOf(frag);
    assert.notStrictEqual(idx, -1, `purge 应包含：${frag}`);
    assert.ok(idx > last, `purge SQL 顺序应为 水位线 → 吊销 → 清键（${frag}）`);
    last = idx;
  }

  seedDb((dbPath) => {
    runJs(js, dbPath);
    const { cfg, revoked, codes } = readAll(dbPath);
    assert.strictEqual(cfg.admin_password_hash, undefined, '密码哈希应删');
    assert.strictEqual(cfg.login_guard_global, undefined, '失败桶应删');
    assert.strictEqual(cfg.admin_token_hash, undefined, 'token 哈希应删');
    assert.strictEqual(codes, 0, '恢复码应清空');
    assert.strictEqual(revoked, 2, '全部会话应吊销');
    assert.ok(cfg.session_revoked_before, '水位线应写');
  });
});

test('do_reset_admin_password：清密码/恢复码/失败桶 + 吊销会话，不动 token/2FA', () => {
  const body = fnBody('do_reset_admin_password');
  const js = embeddedJs(body, 'do_reset_admin_password');
  assert.ok(js.includes('admin_password_hash') && js.includes('recovery_codes'));
  assert.ok(js.indexOf('session_revoked_before') < js.indexOf('admin_password_hash'), '水位线必须最先写');

  seedDb((dbPath) => {
    runJs(js, dbPath);
    const { cfg, revoked, codes } = readAll(dbPath);
    assert.strictEqual(cfg.admin_password_hash, undefined);
    assert.strictEqual(cfg.login_guard_global, undefined);
    assert.strictEqual(codes, 0);
    assert.strictEqual(revoked, 2);
    assert.strictEqual(cfg.admin_token_hash, 'f'.repeat(64), 'token 不应被 reset-admin-password 动');
    assert.strictEqual(cfg.admin_2fa_enabled, '1', '2FA 不应被 reset-admin-password 动');
  });
});

test('do_reset_2fa：清 2FA 键与恢复码 + 吊销会话，不动 token/密码', () => {
  const body = fnBody('do_reset_2fa');
  const js = embeddedJs(body, 'do_reset_2fa');
  assert.ok(js.includes('admin_2fa_secret') && js.includes('admin_2fa_enabled'));
  assert.ok(js.indexOf('session_revoked_before') < js.indexOf('admin_2fa_secret'), '水位线必须最先写');

  seedDb((dbPath) => {
    runJs(js, dbPath);
    const { cfg, revoked, codes } = readAll(dbPath);
    assert.strictEqual(cfg.admin_2fa_secret, undefined);
    assert.strictEqual(cfg.admin_2fa_enabled, undefined);
    assert.strictEqual(codes, 0);
    assert.strictEqual(revoked, 2);
    assert.strictEqual(cfg.admin_token_hash, 'f'.repeat(64), 'token 不应被动');
    assert.ok(cfg.admin_password_hash, '密码不应被 reset-2fa 动');
  });
});
