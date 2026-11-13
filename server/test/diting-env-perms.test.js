'use strict';
// ============================================================
// P0-1 回归：安装器生成/改写 .env 后权限必须收敛到 600。
//
// 风险链：首装窗口期 .env 按 umask 常见 644 → 同机任意用户可读 SESSION_SECRET
// → auth.js 对无 sid 的旧式签名 Cookie 仅验签放行 → 可伪造管理员会话。
//
// 锚定行为：
//   1. 首装：umask 077 创建 + 显式 chmod 600（不依赖 sed -i 的权限实现差异）；
//   2. ensure_session_secret：SESSION_SECRET 已非空时提前 return 也不得跳过 chmod
//      （旧实现在 return 之后才有 chmod，存量宽权限 .env 永远收不紧）；
//   3. 存量分支只同步 PORT，凭据一律不动；
//   4. unit 模板携带 DITING_ENV_FILE，否则 server.js 的权限自检被 catch 静默跳过。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'diting.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');
const UNIT = path.join(__dirname, '..', 'diting-server.service');

function fnBody(name) {
  const start = src.indexOf(`${name}() {`);
  assert.notStrictEqual(start, -1, `diting.sh 应包含 ${name}() 定义`);
  const end = src.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `未能定位 ${name}() 的函数体结尾`);
  return src.slice(start, end + 3);
}

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-env-perms-'));
  return dir;
}

function runIn(dir, code, env) {
  const script = ['set -u', 'RED=;GREEN=;YELLOW=;NC=', fnBody('ensure_session_secret'), fnBody('init_env_file'), code].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: dir, env: Object.assign({}, process.env, env || {}) });
}

function mode(file) {
  return (fs.statSync(file).mode & 0o777).toString(8);
}

test('首装：.env 创建后权限为 600，且生成 SESSION_SECRET/SETUP_TOKEN', () => {
  const dir = mkSandbox();
  // 模板按最常见的 644 放置：umask 077 必须把产物压到 600
  fs.writeFileSync(path.join(dir, '.env.example'), [
    'PORT=8081', 'SESSION_SECRET=', 'SETUP_TOKEN=', 'ADMIN_TOKEN=change-me', '',
  ].join('\n'));
  fs.chmodSync(path.join(dir, '.env.example'), 0o644);

  const r = runIn(dir, 'init_env_file 18081; echo "rc=$?"');
  assert.match(r.stdout, /rc=0/, `init_env_file 应成功：${r.stderr}`);

  const envFile = path.join(dir, '.env');
  assert.strictEqual(mode(envFile), '600', '首装产物 .env 权限必须是 600');
  const body = fs.readFileSync(envFile, 'utf8');
  assert.match(body, /^PORT=18081$/m);
  assert.match(body, /^SESSION_SECRET=[0-9a-f]{64}$/m, 'SESSION_SECRET 应为 32 字节 hex');
  assert.match(body, /^SETUP_TOKEN=[0-9a-f]{32}$/m, 'SETUP_TOKEN 应为 16 字节 hex');
  assert.match(body, /^ADMIN_TOKEN=$/m, '管理员 Token 不预生成');
});

test('存量 .env：权限宽但 SESSION_SECRET 已非空，仍收敛到 600 且值不变（负向对照：旧实现跳过 chmod）', () => {
  const dir = mkSandbox();
  fs.mkdirSync(path.join(dir, 'server'));
  const envFile = path.join(dir, 'server', '.env');
  fs.writeFileSync(envFile, 'SESSION_SECRET=deadbeef-not-empty\nPORT=9000\n');
  fs.chmodSync(envFile, 0o644);

  const r = runIn(dir, 'ensure_session_secret; echo "rc=$?"', { SRC_DIR: dir });
  assert.match(r.stdout, /rc=0/);
  assert.strictEqual(mode(envFile), '600', '已非空的 SESSION_SECRET 不得让 chmod 被提前 return 跳过');
  const body = fs.readFileSync(envFile, 'utf8');
  assert.match(body, /^SESSION_SECRET=deadbeef-not-empty$/m, '已有值不得被覆盖');
  assert.match(body, /^PORT=9000$/m);
});

test('存量 .env：SESSION_SECRET 为空时补齐，且权限 600', () => {
  const dir = mkSandbox();
  fs.mkdirSync(path.join(dir, 'server'));
  const envFile = path.join(dir, 'server', '.env');
  fs.writeFileSync(envFile, 'SESSION_SECRET=\n');
  fs.chmodSync(envFile, 0o644);

  const r = runIn(dir, 'ensure_session_secret; echo "rc=$?"', { SRC_DIR: dir });
  assert.match(r.stdout, /rc=0/);
  assert.strictEqual(mode(envFile), '600');
  assert.match(fs.readFileSync(envFile, 'utf8'), /^SESSION_SECRET=[0-9a-f]{64}$/m);
});

test('存量 .env 走 init_env_file：只同步 PORT，凭据不动，权限仍 600', () => {
  // 生产布局：install_server 的 cwd 是 $SRC_DIR/server，.env 与 ensure_session_secret
  // 读的 $SRC_DIR/server/.env 是同一文件
  const root = mkSandbox();
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(serverDir);
  fs.writeFileSync(path.join(serverDir, '.env.example'), 'PORT=8081\nSESSION_SECRET=\n');
  const envFile = path.join(serverDir, '.env');
  fs.writeFileSync(envFile, 'PORT=8081\nSESSION_SECRET=keep-me\nSETUP_TOKEN=keep-setup\n');
  fs.chmodSync(envFile, 0o644);

  const r = runIn(serverDir, 'init_env_file 19090; echo "rc=$?"', { SRC_DIR: root });
  assert.match(r.stdout, /rc=0/);
  const body = fs.readFileSync(envFile, 'utf8');
  assert.match(body, /^PORT=19090$/m);
  assert.match(body, /^SESSION_SECRET=keep-me$/m, '存量凭据不得被覆盖');
  assert.match(body, /^SETUP_TOKEN=keep-setup$/m);
  assert.strictEqual(mode(envFile), '600');
});

test('缺端口参数应报错返回非零', () => {
  const dir = mkSandbox();
  const r = runIn(dir, 'init_env_file; echo "rc=$?"');
  assert.match(r.stdout, /rc=1/);
});

test('unit 模板携带 DITING_ENV_FILE，否则权限自检被 catch 静默跳过', () => {
  const unit = fs.readFileSync(UNIT, 'utf8');
  assert.match(unit, /^Environment=DITING_ENV_FILE=\/data\/simple-probe-data\/server-data\/\.env$/m,
    'unit 必须显式设置 DITING_ENV_FILE（P0-1 接线）');
  assert.match(unit, /^EnvironmentFile=/m);
});

test('ProtectSystem=strict 必须配 ReadWritePaths（2026-11-13 线上事故回归）', () => {
  // strict = 整个文件系统只读（仅豁免 /dev、/proc、/sys），不是只读 /usr//etc；
  // 不放行写路径时 SQLite 报 "attempt to write a readonly database"，全部上报中断。
  const unit = fs.readFileSync(UNIT, 'utf8');
  if (/^ProtectSystem=strict$/m.test(unit)) {
    assert.match(unit, /^ReadWritePaths=.*server-data/m,
      'ProtectSystem=strict 必须 ReadWritePaths 放行数据库目录');
    assert.match(unit, /ReadWritePaths=.*backups/, '备份目录同样需要写权限');
  }
});

test('install_server 走 init_env_file，diting.sh 语法通过', () => {
  assert.match(fnBody('install_server'), /init_env_file "\$port"/, '首装分支应调用 init_env_file');
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `bash -n 失败：${r.stderr}`);
});
