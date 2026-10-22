'use strict';
// ============================================================
// 回归守卫：diting.sh 的 `--reset-admin-token` 改为「直接写库、立即生效」。
//
// 旧实现的三条失效路径（已全部移除）：
//   1) 硬编码 ${SRC_DIR}/server/.env，非 /opt/diting-src 部署时静默跳过；
//   2) 改 .env 后发 `docker compose restart`——restart 不重建容器，容器 env 仍是旧 Token；
//   3) 原生/systemd 部署完全没有重启动作，进程不重载 .env。
//
// 本文件做三件事：
//   1) 静态断言脚本里不再出现旧路径（compose restart / ensure_docker / 写 .env）；
//   2) 校验 reset 使用的 SQL 语义（水位线 → 吊销会话 → 写哈希 → 清理残留）；
//   3) **真跑**脚本里内嵌的那段 Node 事务：在临时库上执行，断言 HASH_OK=1 且各表如预期。
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

const RESET = fnBody('do_reset_admin_token');

test('reset：不再改 .env、不再 compose restart、不再强依赖 docker', () => {
  assert.ok(!/compose\s+restart/.test(RESET), '不应再下发 docker compose restart（不重建容器 → env 仍旧）');
  assert.ok(!/ensure_docker/.test(RESET), '不应再无条件 ensure_docker（原生部署会被强行装 Docker）');
  assert.ok(!/ADMIN_TOKEN=.*sed|sed.*ADMIN_TOKEN/.test(RESET), '不应再改 .env 里的 ADMIN_TOKEN');
  assert.ok(!/\$\{SRC_DIR:-\}\/server\/\.env/.test(RESET), '不应再硬编码 ${SRC_DIR}/server/.env');
});

test('reset：写库 SQL 语义正确（水位线 → 吊销 → 哈希 → 清理）', () => {
  const sqlOrder = [
    'session_revoked_before',
    'UPDATE sessions SET revoked=1 WHERE revoked=0',
    'admin_token_hash',
    "DELETE FROM admin_config WHERE key IN ('admin_token_raw','admin_initialized')",
  ];
  let last = -1;
  for (const frag of sqlOrder) {
    const idx = RESET.indexOf(frag);
    assert.notStrictEqual(idx, -1, `reset 应包含：${frag}`);
    assert.ok(idx > last, `SQL 顺序应为 水位线 → 吊销 → 哈希 → 清理（${frag} 位置不对）`);
    last = idx;
  }
  assert.ok(RESET.includes('db.transaction'), '多条写操作应包在事务里');
  assert.ok(RESET.includes('busy_timeout'), '运行中写库应设置 busy_timeout');
});

test('reset：自检改打管理面只读端点（规避 2FA 与 loginGuard）', () => {
  assert.ok(RESET.includes('/api/admin/alert-rules'), '自检应打 /api/admin/alert-rules（adminOrReadonly）');
  assert.ok(RESET.includes('X-Admin-Token'), '自检应带 X-Admin-Token 头');
  assert.ok(RESET.includes('X-Forwarded-Proto: https'), '自检应带 X-Forwarded-Proto（requireProto 口径）');
  // 注释里会提到"不用 /api/login"，这里只断言实际请求 URL 不是它
  assert.ok(
    !/http:\/\/127\.0\.0\.1:\$\{port\}\/api\/login/.test(RESET),
    '自检 URL 不应是 /api/login（2FA 实例必失败、3 次失败封 IP）'
  );
});

test('reset 内嵌的 Node 事务：在临时库上真实执行', () => {
  const m = RESET.match(/cat > "\$js" <<'JS'\n([\s\S]*?)\nJS\n/);
  assert.ok(m, '未能从 do_reset_admin_token 中提取内嵌 JS');
  const js = m[1];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-reset-'));
  const dbPath = path.join(dir, 'monitor.db');
  const jsPath = path.join(dir, 'reset.js');

  // 造一个最小库：admin_config + sessions，并预置"历史残留"
  const d = new Database(dbPath);
  d.exec(`
    CREATE TABLE admin_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, revoked INTEGER NOT NULL DEFAULT 0);
  `);
  d.prepare('INSERT INTO admin_config(key,value) VALUES(?,?)').run('admin_token_raw', 'adm_legacy_plaintext');
  d.prepare('INSERT INTO admin_config(key,value) VALUES(?,?)').run('admin_initialized', '1');
  d.prepare('INSERT INTO admin_config(key,value) VALUES(?,?)').run('session_revoked_before', '1');
  d.prepare('INSERT INTO sessions(id) VALUES(?)').run('sess-a');
  d.prepare('INSERT INTO sessions(id) VALUES(?)').run('sess-b');
  d.close();

  fs.writeFileSync(jsPath, js);
  const HASH = 'a'.repeat(64);
  // 脚本放在临时目录 → node 的模块解析根是临时目录，必须用 NODE_PATH 指向服务端依赖，
  // 与 diting.sh 的 db_run_js 在原生分支里的做法一致（T0.0/G1）。
  const r = spawnSync('node', [jsPath, dbPath, HASH], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules') },
  });
  assert.strictEqual(r.status, 0, `执行内嵌 JS 失败：${r.stderr}`);
  assert.match(r.stdout, /HASH_OK=1/);

  // 断言落库结果
  const v = new Database(dbPath, { readonly: true });
  const get = (k) => v.prepare('SELECT value FROM admin_config WHERE key=?').get(k);
  assert.strictEqual(get('admin_token_hash').value, HASH, '应写入新哈希');
  assert.strictEqual(get('admin_token_raw'), undefined, '应清理历史明文');
  assert.strictEqual(get('admin_initialized'), undefined, '应清理废弃锁');
  const wm = Number(get('session_revoked_before').value);
  assert.ok(wm > 1, '水位线应被更新为当前时间');
  const rows = v.prepare('SELECT id, revoked FROM sessions ORDER BY id').all();
  assert.deepStrictEqual(rows.map((x) => x.revoked), [1, 1], '既有会话应全部吊销');
  v.close();

  for (const f of [jsPath, dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  try { fs.rmdirSync(dir); } catch { /* 忽略 */ }
});

test('sha256 口径：脚本算法与 server 端 hashToken 一致', () => {
  const crypto = require('node:crypto');
  const token = 'adm_0123456789abcdef0123456789abcdef0123456789abcdef';
  const expected = crypto.createHash('sha256').update(token).digest('hex');

  const helper = fnBody('sha256_hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-sha-'));
  const sh = path.join(dir, 'sha.sh');
  fs.writeFileSync(sh, `#!/usr/bin/env bash\n${helper}\nsha256_hex "$1"\n`);
  const r = spawnSync('bash', [sh, token], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), expected, '脚本 sha256 必须与 crypto.createHash("sha256") 一致');
  try { fs.unlinkSync(sh); fs.rmdirSync(dir); } catch { /* 忽略 */ }
});
