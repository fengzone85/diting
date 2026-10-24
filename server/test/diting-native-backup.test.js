'use strict';
// ============================================================
// 回归守卫：原生（systemd）部署不该被 Docker 拦住。
//
// 旧实现在 do_backup / do_restore / do_db_stats / do_clear_ip_whitelist 入口
// 无条件 `ensure_docker`，而 locate_db / db_run_js 本来都有宿主机文件分支。
// 结果：没装 Docker 的原生用户连备份、恢复、清白名单都跑不了 —— 恰恰是出问题时
// 最需要的几条命令（实测：`sudo bash diting.sh --backup` 直接报
// "Docker 安装失败或守护进程无法启动"）。
//
// 现在改为按库形态判定：只有 locate_db 返回 docker:<cid>:… 时才要求 Docker。
// 安装 / 更新服务端本身仍是 Docker-only，保留裸 ensure_docker。
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

// 用桩替掉 locate_db / ensure_docker，单独验证判定逻辑
function runGuard(loc, dockerRc) {
  const code = [
    'set -u',
    `locate_db() { printf '%s' "${loc}"; }`,
    `ensure_docker() { printf 'DOCKER_CALLED'; return ${dockerRc}; }`,
    fnBody('ensure_docker_if_volume'),
    'ensure_docker_if_volume; printf "|rc=%s" "$?"',
  ].join('\n');
  return spawnSync('bash', ['-c', code], { encoding: 'utf8' });
}

test('原生（file 形态）：不需要 Docker，也不去调用它', () => {
  for (const loc of ['file:/data/simple-probe/server/data/monitor.db', '']) {
    const r = runGuard(loc, 1); // 即使 ensure_docker 会失败也不该被调用
    assert.ok(!r.stdout.includes('DOCKER_CALLED'), `locate_db="${loc}" 时不应调用 ensure_docker`);
    assert.match(r.stdout, /rc=0/, `locate_db="${loc}" 应放行`);
  }
});

test('Docker 卷形态：仍要求 Docker，失败则中止', () => {
  const ok = runGuard('docker:abc123:server:/data/monitor.db', 0);
  assert.match(ok.stdout, /DOCKER_CALLED/, 'docker: 形态应调用 ensure_docker');
  assert.match(ok.stdout, /rc=0/);

  const fail = runGuard('docker:abc123:server:/data/monitor.db', 1);
  assert.match(fail.stdout, /rc=1/, 'ensure_docker 失败时必须中止');
});

test('数据类命令不再裸调 ensure_docker（否则原生部署全废）', () => {
  // F8.6 起 do_restore 是审计外壳，恢复主体在 _restore_apply（库形态判定也在这）。
  for (const fn of ['do_backup', '_restore_apply', 'do_db_stats', 'do_clear_ip_whitelist']) {
    const body = fnBody(fn);
    assert.ok(!/^\s*ensure_docker \|\| (return|exit) 1\s*$/m.test(body),
      `${fn} 不该无条件 ensure_docker`);
    assert.match(body, /ensure_docker_if_volume/, `${fn} 应改为按库形态判定`);
  }
});

test('安装 / 更新服务端仍要求 Docker', () => {
  for (const fn of ['install_server', 'update_server']) {
    assert.match(fnBody(fn), /ensure_docker \|\| (return|exit) 1/,
      `${fn} 是 Docker 部署路径，应保留 ensure_docker`);
  }
});

test('diting.sh 语法校验通过', () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `bash -n 失败：${r.stderr}`);
});
