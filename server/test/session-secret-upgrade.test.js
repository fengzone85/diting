'use strict';
// ============================================================
// 行为测试：diting.sh 的 ensure_session_secret（审查修复 P1-1）
//
// 真实执行函数体（不是文本断言）：造一份存量 .env（SESSION_SECRET 为空 / 缺失 / 已有值），
// 断言补齐结果、幂等性与文件权限，不依赖真实部署。
//
// 背景：install_server 首装分支会生成 SESSION_SECRET，但 else 分支与 update_server
// 都不会补。该值缺失时服务端每次重启随机生成，既丢登录态，也让 distribution.js
// 由它派生的下载 token 全部作废。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'diting.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

function fnBody(name) {
  const start = src.indexOf(`\n${name}() {`);
  assert.notStrictEqual(start, -1, `diting.sh 应包含 ${name}() 定义`);
  const end = src.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `未能定位 ${name}() 的函数体结尾`);
  return src.slice(start + 1, end + 3);
}

function setup(envContent, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-sess-'));
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  const envPath = path.join(dir, 'server', '.env');
  fs.writeFileSync(envPath, envContent);
  if (mode) fs.chmodSync(envPath, mode);
  return { dir, envPath };
}

// 连跑两次：第二次用于验证幂等（不应再打印“已补齐”）。
function run(dir) {
  const script = `
SRC_DIR="${dir}"
GREEN=''; YELLOW=''; NC=''
${fnBody('ensure_session_secret')}
ensure_session_secret
ensure_session_secret
`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: dir });
}

function readSecret(envPath) {
  const m = fs.readFileSync(envPath, 'utf8').match(/^SESSION_SECRET=(.*)$/m);
  return m ? m[1].trim() : null;
}

test('行为：SESSION_SECRET 为空 → 补齐 64 位 hex，其他行不动', () => {
  const { dir, envPath } = setup('PORT=8081\nSESSION_SECRET=\nADMIN_TOKEN=\n');
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(readSecret(envPath), /^[0-9a-f]{64}$/, '应补齐为 openssl rand -hex 32 的形态');
  const after = fs.readFileSync(envPath, 'utf8');
  assert.match(after, /^PORT=8081$/m, 'PORT 行必须保留');
  assert.match(after, /^ADMIN_TOKEN=$/m, 'ADMIN_TOKEN 行不得被改动');
  assert.match(r.stdout, /已补齐 SESSION_SECRET/);
  assert.match(r.stdout, /一次性安装\/下载链接将失效/, '必须提示分发链接会失效');
});

test('行为：缺少 SESSION_SECRET 行 → 追加而不是覆盖文件', () => {
  const { dir, envPath } = setup('PORT=8081\nREADONLY_TOKEN=\n');
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(readSecret(envPath), /^[0-9a-f]{64}$/);
  assert.match(fs.readFileSync(envPath, 'utf8'), /^READONLY_TOKEN=$/m);
});

test('行为：已有非空值 → 原样保留（幂等，两次执行不变化）', () => {
  const fixed = 'b'.repeat(64);
  const { dir, envPath } = setup(`PORT=8081\nSESSION_SECRET=${fixed}\n`);
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readSecret(envPath), fixed, '既有值不得被覆盖');
  assert.doesNotMatch(r.stdout, /已补齐 SESSION_SECRET/, '已有值时不应打印补齐提示');
});

test('行为：补齐后 .env 权限收敛到 600', () => {
  const { dir, envPath } = setup('SESSION_SECRET=\n', 0o644);
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const mode = fs.statSync(envPath).mode & 0o777;
  assert.strictEqual(mode, 0o600, '.env 含密钥，补齐后应为 600');
});

test('接线：server.js 启动时对未设置 SESSION_SECRET 告警', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /SESSION_SECRET 未设置/, '缺少启动告警：原生/手工部署将无声丢失登录态');
});

test('接线：diting.sh 在安装存量分支与升级路径都调用了 ensure_session_secret', () => {
  const installCalls = src.match(/ensure_session_secret/g) || [];
  // 1 处函数定义 + 2 处调用
  assert.ok(installCalls.length >= 3, `应至少有定义 + 安装/升级两处调用，实际 ${installCalls.length}`);
});
