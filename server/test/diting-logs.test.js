'use strict';
// ============================================================
// 回归守卫：`diting.sh --logs` 统一排障入口。
//
// 排障时最烦的是"先判断这套是 systemd 还是 Docker，再想该敲哪条命令"。
// do_logs 自动识别：有 diting-server.service → journalctl；否则看 compose 容器 → logs。
// 两者都没有时明确报错（而不是静默返回 0，让人以为没有日志）。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'diting.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

function fnBody(name) {
  const start = src.indexOf(`${name}() {`);
  assert.notStrictEqual(start, -1, `diting.sh 应包含 ${name}() 定义`);
  const end = src.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `未能定位 ${name}() 的函数体结尾`);
  return src.slice(start, end + 3);
}

// 用 bash 函数桩掉 systemctl / journalctl / docker，验证分支选择
function runLogs({ systemd, dockerRunning, arg = '' }) {
  const code = [
    'set -u',
    "SRC_DIR='/tmp/diting-logs-test'",
    "RED=''; NC=''",        // 脚本里颜色常量是全局的，单测里要补齐（set -u 下缺失会直接退出）
    `systemctl() { ${systemd ? 'return 0' : 'return 1'}; }`,
    'journalctl() { printf "JOURNALCTL:%s\\n" "$*"; }',
    `docker() { ${dockerRunning ? 'printf "cid\\n"' : 'printf ""'}; }`,
    fnBody('do_logs'),
    `do_logs ${arg ? `'${arg}'` : ''}`,
    'printf "RC=%s" "$?"',
  ].join('\n');
  return spawnSync('bash', ['-c', code], { encoding: 'utf8' });
}

test('systemd 形态：走 journalctl，默认 100 行', () => {
  const r = runLogs({ systemd: true, dockerRunning: false });
  assert.match(r.stdout, /JOURNALCTL:-u diting-server -n 100 --no-pager/);
  assert.match(r.stdout, /RC=0/);
});

test('systemd 形态：--logs 200 传成 -n 200', () => {
  const r = runLogs({ systemd: true, dockerRunning: false, arg: '200' });
  assert.match(r.stdout, /-n 200/);
});

test('systemd 形态：follow 追加 -f', () => {
  const r = runLogs({ systemd: true, dockerRunning: false, arg: 'follow' });
  assert.match(r.stdout, /-n 100 --no-pager -f/);
});

test('两种形态都没有：明确报错且返回非零', () => {
  const r = runLogs({ systemd: false, dockerRunning: false });
  assert.match(r.stdout, /RC=1/);
  assert.match(r.stderr, /未找到运行中的服务端/);
});

test('静态：--logs 已接入 usage / 解析 / 分发', () => {
  assert.match(src, /--logs\)\n\s+ACTION="logs"/, '应解析 --logs');
  assert.match(src, /logs\)\s+do_logs/, '应分发到 do_logs');
  assert.match(src, /--logs \[行数\|follow\]/, 'usage 应有说明');
  // 可选值只吞"像行数/follow"的参数，避免把后续选项当成行数
  assert.match(src, /"\$1" =~ \^\[0-9\]\+\$ \|\| "\$1" == "follow"/);
});

test('diting.sh 语法校验通过', () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `bash -n 失败：${r.stderr}`);
});
