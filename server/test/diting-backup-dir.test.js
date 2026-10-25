'use strict';
// ============================================================
// 回归守卫：CLI 备份目录与服务端 BACKUP_DIR 必须是同一个。
//
// 旧实现把 DB_BACKUP_DIR 写死 /var/backups/diting（宿主侧），而服务端读 .env 的
// BACKUP_DIR（原生部署时是 /data/backups 或用户自定路径）。结果本机实测：
//   CLI     : /var/backups/diting/monitor_20261022_224202.db.gz
//   后台接口: {"dir":"/opt/diting-backups","available":false,"files":[]}
// 用户在后台「备份」页永远看不到 CLI 产物，保留策略也各管一套。
//
// 现在按部署形态解析：
//   Docker（库在命名卷）→ 宿主侧固定 /var/backups/diting（.env 里是容器内路径）
//   原生（库是宿主机文件）→ 跟随 .env 的 BACKUP_DIR
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
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

// 造一个临时 SRC_DIR（可带 server/.env），跑真实的 _init_backup_dir
function runInit({ loc, envContent, preset = '' }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-bdir-'));
  try {
    if (envContent != null) {
      fs.mkdirSync(path.join(tmp, 'server'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'server', '.env'), envContent);
    }
    const code = [
      'set -u',
      `SRC_DIR='${tmp}'`,
      `locate_db() { printf '%s' '${loc}'; }`,
      preset ? `DB_BACKUP_DIR='${preset}'` : 'DB_BACKUP_DIR=""',
      fnBody('_init_backup_dir'),
      '_init_backup_dir',
      'printf "%s" "$DB_BACKUP_DIR"',
    ].join('\n');
    return spawnSync('bash', ['-c', code], { encoding: 'utf8' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('Docker 形态：宿主侧固定 /var/backups/diting（.env 里是容器内路径）', () => {
  const r = runInit({ loc: 'docker:abc123:server:/data/monitor.db', envContent: 'BACKUP_DIR=/data/backups\n' });
  assert.strictEqual(r.stdout, '/var/backups/diting', r.stderr);
});

test('原生形态：跟随 .env 的 BACKUP_DIR（这是本机踩坑的场景）', () => {
  const r = runInit({ loc: 'file:/data/x/monitor.db', envContent: 'PORT=8081\nBACKUP_DIR=/opt/diting-backups\n' });
  assert.strictEqual(r.stdout, '/opt/diting-backups', r.stderr);
});

test('原生形态但 .env 没写 BACKUP_DIR：回落 /var/backups/diting', () => {
  const r = runInit({ loc: 'file:/data/x/monitor.db', envContent: 'PORT=8081\n' });
  assert.strictEqual(r.stdout, '/var/backups/diting', r.stderr);
});

test('$SRC_DIR 不存在（从仓库直跑）时，靠"脚本同级 / 当前目录"仍能找到 .env', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-bdir-'));
  try {
    fs.mkdirSync(path.join(tmp, 'server'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'server', '.env'), 'BACKUP_DIR=/opt/from-cwd\n');
    const code = [
      'set -u',
      "SRC_DIR='/nonexistent-src'",      // 本机真实情形：/opt/diting-src 并不存在
      'locate_db() { printf "%s" "file:/x"; }',
      'DB_BACKUP_DIR=""',
      fnBody('_init_backup_dir'),
      '_init_backup_dir',
      'printf "%s" "$DB_BACKUP_DIR"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', code], { encoding: 'utf8', cwd: tmp });
    assert.strictEqual(r.stdout, '/opt/from-cwd', `应从 ./server/.env 读到值，实际 ${r.stdout} ${r.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('显式传入 DB_BACKUP_DIR 时不被覆盖（运维覆盖 / 测试注入）', () => {
  const r = runInit({ loc: 'file:/data/x/monitor.db', envContent: 'BACKUP_DIR=/opt/ignored\n', preset: '/custom/dir' });
  assert.strictEqual(r.stdout, '/custom/dir', r.stderr);
});

test('重复调用不会重新解析（幂等）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-bdir-'));
  try {
    fs.mkdirSync(path.join(tmp, 'server'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'server', '.env'), 'BACKUP_DIR=/opt/a\n');
    const code = [
      'set -u',
      `SRC_DIR='${tmp}'`,
      'locate_db() { printf "%s" "file:/x"; }',
      'DB_BACKUP_DIR=""',
      fnBody('_init_backup_dir'),
      '_init_backup_dir',
      'DB_BACKUP_DIR="/changed"',
      '_init_backup_dir',
      'printf "%s" "$DB_BACKUP_DIR"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', code], { encoding: 'utf8' });
    assert.strictEqual(r.stdout, '/changed', '二次调用不应把值改回 .env 解析结果');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('server_run_user：只在 systemd 且非 root 时返回用户（备份要 chown 给他）', () => {
  const run = (unitUser) => {
    const code = [
      'set -u',
      `systemctl() { printf '%s' '${unitUser}'; }`,
      fnBody('server_run_user'),
      'server_run_user',
    ].join('\n');
    return spawnSync('bash', ['-c', code], { encoding: 'utf8' }).stdout.trim();
  };
  assert.strictEqual(run('feng'), 'feng', '普通用户应原样返回');
  assert.strictEqual(run('root'), '', 'root 不需要 chown');
  assert.strictEqual(run(''), '', '非 systemd 部署返回空');
});

test('静态：备份后要把目录与产物交给服务端用户（否则后台上传/下载 EACCES）', () => {
  const backup = fnBody('do_backup');
  assert.match(backup, /server_run_user/, '应探测服务端运行用户');
  assert.match(backup, /chown "\$_svc_user" "\$DB_BACKUP_DIR"/, '目录要 chown');
  assert.match(backup, /monitor_\*\.db\.gz/, '历史产物也要修（旧版本是 root 0600）');
  assert.match(backup, /chown "\$_svc_user" "\$final_path"/, '新产物要 chown');
});

test('静态：默认值不再硬编码，且各入口都做了初始化', () => {
  assert.match(src, /^DB_BACKUP_DIR="\$\{DB_BACKUP_DIR:-\}"$/m, '默认值应为空，交给 _init_backup_dir 解析');
  for (const fn of ['do_backup', 'do_backup_schedule', 'do_backup_list', 'update_server']) {
    assert.match(fnBody(fn), /_init_backup_dir/, `${fn} 应调用 _init_backup_dir`);
  }
  // F8.6 起 do_restore 只是「审计外壳」，恢复主体在 _restore_apply（仍要初始化目录）
  assert.match(fnBody('do_restore'), /_restore_apply/, 'do_restore 应委托恢复主体');
  assert.match(fnBody('_restore_apply'), /_init_backup_dir/, '_restore_apply 应调用 _init_backup_dir');
});

test('diting.sh 语法校验通过', () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `bash -n 失败：${r.stderr}`);
});
