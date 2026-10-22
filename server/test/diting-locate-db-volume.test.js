'use strict';
// ============================================================
// 回归守卫：locate_db 的 Docker 命名卷解析（T1.9 真机验收发现）
//
// 背景：compose v2 的卷名是「<项目名>_server-data」（项目名默认取 compose 文件
// 所在目录名；本仓库 compose 在 server/ 下 → server_server-data）。原实现只
// `docker volume inspect server-data`，于是 Docker 形态下**所有**库操作静默失败：
// 升级前备份、Token 迁移（migrate_env_admin_token）、--reset-admin-token、
// 备份保留天数……调用点普遍带 `2>/dev/null || true`，报错看不见。
//
// 本测试用假 docker 命令驱动真实 locate_db，覆盖三种卷名形态。
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

// 构造一个只有 locate_db 依赖的最小环境：假 docker + 假 .env（无 DB_PATH）
function run(volumes, envDbPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-loc-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const docker = path.join(bin, 'docker');
  fs.writeFileSync(docker, `#!/usr/bin/env bash
# 假 docker：只实现 locate_db 用到的三个子命令
case "$1 $2" in
  "volume inspect")
     for v in ${volumes.map((v) => `"${v}"`).join(' ')}; do [[ "$3" == "$v" ]] && exit 0; done
     exit 1 ;;
  "volume ls")   for v in ${volumes.map((v) => `"${v}"`).join(' ')}; do echo "$v"; done; exit 0 ;;
  "ps -q")       echo "cid-123"; exit 0 ;;
  "inspect --format") echo "server"; exit 0 ;;
esac
exit 0
`);
  fs.chmodSync(docker, 0o755);
  // 空的 server/.env：确保不走原生 file: 分支（DB_PATH 缺失）
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', '.env'), 'PORT=8081\n');
  fs.writeFileSync(path.join(dir, 'server', 'data', ''), ''); // 占位，避免回退分支误命中
  const script = `
SRC_DIR="${dir}"
PATH="${bin}:$PATH"
${fnBody('locate_db')}
locate_db
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r.stdout.trim();
}

test('compose v2 前缀卷名（server_server-data）必须能定位', () => {
  const out = run(['server_server-data'], '');
  assert.strictEqual(out, 'docker:cid-123:server:/data/monitor.db');
});

test('裸卷名（server-data，早期手工创建）必须能定位', () => {
  const out = run(['server-data'], '');
  assert.strictEqual(out, 'docker:cid-123:server:/data/monitor.db');
});

test('任意项目名前缀（diting_server-data / probe_server-data）必须能定位', () => {
  for (const v of ['diting_server-data', 'probe_server-data']) {
    assert.strictEqual(run([v], ''), 'docker:cid-123:server:/data/monitor.db', v);
  }
});

test('形态不符的同名卷（server-data-old / myserver-data-x）不得误命中', () => {
  // server-data-old 既不是裸名也不是 <前缀>_server-data → 应落到文件回退（空）
  assert.strictEqual(run(['server-data-old'], ''), '', '不应把 server-data-old 当成数据卷');
});
