'use strict';
// ============================================================
// P0-2 回归：恢复覆盖数据库必须「停服 + 临时文件 + 原子 rename + 复核 + 失败回滚」。
//
// 风险链（修前）：宿主机分支只尝试 docker compose down，原生 systemd 部署不
// 停服即 `cp` 直写运行中的 monitor.db；cp 非原子，断电/中断留半截库；失败路径
// 还会把服务留在停止态。
//
// 锚定行为：
//   1. 宿主机分支：systemd/compose 先停服（识别不了则显式告警），目标同目录
//      .restore.tmp + 复核 + mv 原子替换；禁止 cp 直写目标；
//   2. 容器分支：docker cp 进容器内同目录临时文件 + 字节复核 + 容器内 mv；
//   3. 卷分支：卷内临时文件 + cmp + mv，不得直接覆盖 /data/monitor.db；
//   4. 无论成败：替换前停掉的服务必须被拉回（RETURN trap 兜底 _restore_ensure_started）；
//   5. 失败路径保留原库与 .before_restore.bak。
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

const applyBody = fnBody('_restore_apply');

test('宿主机/容器/卷三分支均为临时文件 + 原子 rename，无 cp 直写目标', () => {
  // 负向对照：旧实现 `cp "$restore_src" "$fpath"` 直写必须消失
  assert.ok(!/cp "\$restore_src" "\$fpath"/.test(applyBody), '禁止 cp 直写目标库');
  assert.ok(!/docker cp "\$\{restore_src\}\.tmp" "\$\{cid\}:\$\{cpath\}"/.test(applyBody),
    '容器分支不得把临时副本直接 cp 覆盖目标');
  assert.ok(!/cp "\/in\/\$srcname" \/data\/monitor\.db\s*["\\]/.test(applyBody),
    '卷分支不得直接 cp 覆盖 /data/monitor.db');

  // 三个分支各有 tmp + mv
  assert.match(applyBody, /docker cp "\$restore_src" "\$\{cid\}:\$\{cpath\}\.restore\.tmp"/);
  assert.match(applyBody, /docker exec "\$cid" mv -f "\$\{cpath\}\.restore\.tmp" "\$\{cpath\}"/);
  assert.match(applyBody, /mv -f \/data\/monitor\.db\.restore\.tmp \/data\/monitor\.db/);
  assert.match(applyBody, /cp "\$restore_src" "\$\{fpath\}\.restore\.tmp"/);
  assert.match(applyBody, /mv -f "\$\{fpath\}\.restore\.tmp" "\$fpath"/);
});

test('替换发生在停服之后、恢复启动之前', () => {
  const stopIdx = applyBody.indexOf('systemctl stop diting-server.service');
  const mvIdx = applyBody.indexOf('mv -f "${fpath}.restore.tmp" "$fpath"');
  // trap 行也引用 _restore_ensure_started，取末尾的显式调用点
  const startIdx = applyBody.lastIndexOf('_restore_ensure_started');
  assert.ok(stopIdx > -1 && mvIdx > stopIdx, '宿主机分支必须先停服再替换');
  assert.ok(startIdx > mvIdx, '替换后才拉起服务');
  const chownIdx = applyBody.indexOf('chown --reference');
  assert.ok(chownIdx > -1 && chownIdx < mvIdx, '替换前必须按原库校准属主/权限（否则服务打不开新库）');

  const dStop = applyBody.indexOf('docker stop "$cid"');
  const dMv = applyBody.indexOf('docker exec "$cid" mv -f');
  assert.ok(dStop > -1 && dMv > dStop, '容器分支必须先停容器再替换');

  // -wal/-shm 清理必须在 mv 之后
  const walIdx = applyBody.indexOf('rm -f "${fpath}-wal"');
  assert.ok(walIdx > mvIdx, 'wal/shm 清理必须在新库就位之后');
});

test('失败路径：trap 统一兜底拉起服务，_restore_ensure_started 覆盖四种停服形态', () => {
  const trapLine = applyBody.split('\n').find((l) => l.includes('trap ') && l.includes('RETURN'));
  assert.ok(trapLine && trapLine.includes('_restore_ensure_started'),
    'RETURN trap 必须带服务恢复兜底');
  const ensure = fnBody('_restore_ensure_started');
  for (const mode of ['systemd', 'compose', 'docker', 'volume']) {
    assert.match(ensure, new RegExp(`${mode}\\)`), `_restore_ensure_started 应覆盖 ${mode} 形态`);
  }
  assert.match(applyBody, /_restore_verify_tmp/, '宿主机分支应对目标侧副本复核');
  assert.match(fnBody('_restore_verify_tmp'), /integrity_check|stat -c %s/, '复核用 integrity_check 或字节数比对');
});

test('stub 桩：宿主机（systemd）恢复时序 stop → mv → start，替换生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-restore-atomic-'));
  const db = path.join(dir, 'monitor.db');
  const backup = path.join(dir, 'backup.db');
  const log = path.join(dir, 'events.log');
  fs.writeFileSync(db, 'SQLite format 3\0OLD');
  fs.writeFileSync(backup, 'SQLite format 3\0NEW');

  const harness = [
    'set -u',
    'RED=;GREEN=;YELLOW=;NC=',
    'RESTORE_RESULT=""; RESTORE_PRE_BACKUP=""',
    'LOG="$1"; DB="$2"; BAK="$3"; SRC_DIR=/nonexistent',
    '_init_backup_dir() { DB_BACKUP_DIR="$(dirname "$DB")"; }',
    'ensure_docker_if_volume() { return 0; }',
    'locate_db() { printf "file:%s" "$DB"; }',
    'do_backup() { :; }',
    '_restore_pending_payload() { echo "{}"; }',
    '_restore_mark_pending_db() { return 0; }',
    '_restore_write_pending_file() { return 0; }',
    'db_backup_state_set() { :; }',
    'systemctl() { case "$1" in cat) return 0;; stop) echo "stop" >> "$LOG"; return 0;; start) echo "start" >> "$LOG"; return 0;; *) return 0;; esac; }',
    'docker() { echo "docker $*" >> "$LOG"; return 0; }',
    'mv() { echo "mv $2" >> "$LOG"; command mv "$@"; }',
    'chown() { echo "chown $*" >> "$LOG"; }',
    'chmod() { echo "chmod $*" >> "$LOG"; }',
    'sqlite3() { echo ok; }',
    fnBody('_restore_verify_tmp'),
    fnBody('_restore_ensure_started'),
    fnBody('_restore_apply'),
    '_restore_apply "$BAK" || echo "rc=$?" >> "$LOG"',
    'echo "content=$(cat "$DB")" >> "$LOG"',
  ].join('\n');

  const r = spawnSync('bash', ['-c', harness, 'bash', log, db, backup], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `桩运行失败：${r.stderr}`);

  const events = fs.readFileSync(log, 'utf8').split('\n');
  const stopAt = events.indexOf('stop');
  const mvAt = events.findIndex((l) => l.includes('.restore.tmp') && l.startsWith('mv'));
  const startAt = events.indexOf('start');
  const chownAt = events.findIndex((l) => l.startsWith('chown'));
  assert.ok(stopAt > -1, '应有 systemctl stop');
  assert.ok(mvAt > stopAt, `mv 应在 stop 之后：${events.join('|')}`);
  assert.ok(startAt > mvAt, `start 应在 mv 之后：${events.join('|')}`);
  assert.ok(chownAt > -1 && chownAt < mvAt, `属主/权限校准必须在 mv 之前：${events.join('|')}`);
  assert.ok(events.some((l) => l.includes('content=') && l.includes('NEW')), '目标库应被新库替换');
  assert.ok(fs.existsSync(`${db}.before_restore.bak`), '应保留 .before_restore.bak');
  assert.ok(!fs.existsSync(`${db}.restore.tmp`), '临时文件不应残留');
});

test('stub 桩：复核失败 → 原库不动、tmp 清理、服务仍被拉起', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-restore-fail-'));
  const db = path.join(dir, 'monitor.db');
  const backup = path.join(dir, 'backup.db');
  const log = path.join(dir, 'events.log');
  fs.writeFileSync(db, 'SQLite format 3\0OLD');
  fs.writeFileSync(backup, 'SQLite format 3\0NEW');

  const harness = [
    'set -u',
    'RED=;GREEN=;YELLOW=;NC=',
    'RESTORE_RESULT=""; RESTORE_PRE_BACKUP=""',
    'LOG="$1"; DB="$2"; BAK="$3"; SRC_DIR=/nonexistent',
    '_init_backup_dir() { DB_BACKUP_DIR="$(dirname "$DB")"; }',
    'ensure_docker_if_volume() { return 0; }',
    'locate_db() { printf "file:%s" "$DB"; }',
    'do_backup() { :; }',
    '_restore_pending_payload() { echo "{}"; }',
    '_restore_mark_pending_db() { return 0; }',
    '_restore_write_pending_file() { return 0; }',
    'db_backup_state_set() { :; }',
    'systemctl() { case "$1" in cat) return 0;; stop) echo "stop" >> "$LOG"; return 0;; start) echo "start" >> "$LOG"; return 0;; *) return 0;; esac; }',
    'mv() { echo "mv $2" >> "$LOG"; command mv "$@"; }',
    'sqlite3() { case "$1" in *.restore.tmp) echo corrupt;; *) echo ok;; esac; }', // 仅目标侧复核失败
    fnBody('_restore_verify_tmp'),
    fnBody('_restore_ensure_started'),
    fnBody('_restore_apply'),
    '_restore_apply "$BAK" || echo "rc=$?" >> "$LOG"',
  ].join('\n');

  const r = spawnSync('bash', ['-c', harness, 'bash', log, db, backup], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `桩运行失败：${r.stderr}`);

  const events = fs.readFileSync(log, 'utf8');
  assert.match(events, /rc=1/, '复核失败应返回非零');
  assert.strictEqual(fs.readFileSync(db, 'utf8'), 'SQLite format 3\0OLD', '失败路径原库必须不动');
  assert.ok(!fs.existsSync(`${db}.restore.tmp`), '失败后 tmp 必须清理');
  assert.match(events, /start/, '失败路径也必须把服务拉起（trap 兜底）');
  const stopAt = events.split('\n').indexOf('stop');
  const startAt = events.split('\n').indexOf('start');
  assert.ok(startAt > stopAt, 'start 必须发生在 stop 之后');
});

test('locate_db：固定 .env 候选落空时回退 unit 的 EnvironmentFile（运行目录分离布局）', () => {
  // 2026-11-12 真机演练暴露：N5100 运行目录分离后 .env 在仓库树外（unit
  // EnvironmentFile 指定），三个固定候选全落空 → CLI 备份/恢复永远无法定位数据库
  assert.match(fnBody('locate_db'), /server_env_file/, 'locate_db 必须问 unit 要环境文件路径');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-locate-envfile-'));
  const dbFile = path.join(dir, 'monitor.db');
  const envFile = path.join(dir, 'prod.env');
  fs.writeFileSync(dbFile, 'x');
  fs.writeFileSync(envFile, `DB_PATH=${dbFile}\n`);

  const harness = [
    'set -u',
    `SRC_DIR=/nonexistent`,
    `server_env_file() { printf '%s' "${envFile}"; }`,
    'docker() { return 1; }',
    fnBody('locate_db'),
    'locate_db',
  ].join('\n');
  const r = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `桩运行失败：${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), `file:${dbFile}`);
});

test('P1-8 恢复请求：目标必须在备份目录内，目录外/软链逃逸一律拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-restore-path-'));
  const backupDir = path.join(dir, 'backups');
  const outside = path.join(dir, 'outside.db');
  fs.mkdirSync(backupDir);
  fs.writeFileSync(path.join(backupDir, 'ok.db'), 'x');
  fs.writeFileSync(outside, 'x');
  fs.symlinkSync(outside, path.join(backupDir, 'escape.db'));

  const harness = (file) => [
    'set -u',
    'RED=;GREEN=;YELLOW=;NC=',
    `BACKUP_VISIBLE_DIR="${backupDir}"`,
    `RESTORE_REQUEST_FILE="${backupDir}/restore.request"`,
    'RESTORE_CALLED=""',
    '_init_backup_dir() { DB_BACKUP_DIR="$BACKUP_VISIBLE_DIR"; }',
    'do_restore() { echo "RESTORE_CALLED $1"; }',
    fnBody('process_restore_request'),
    `printf '{"file":"${file}","name":"n","by":"admin"}' > "$BACKUP_VISIBLE_DIR/restore.request"`,
    'process_restore_request || echo "rc=$?"',
  ].join('\n');

  // 目录内文件：放行并调用 do_restore
  const ok = spawnSync('bash', ['-c', harness(path.join(backupDir, 'ok.db'))], { encoding: 'utf8' });
  assert.match(ok.stdout, /RESTORE_CALLED .*ok\.db/, `正常备份文件应放行：${ok.stdout}${ok.stderr}`);

  // 目录外文件：拒绝
  const bad = spawnSync('bash', ['-c', harness(outside)], { encoding: 'utf8' });
  assert.ok(!bad.stdout.includes('RESTORE_CALLED'), '目录外文件不得恢复');
  assert.match(bad.stdout + bad.stderr, /不在备份目录内|已拒绝/);

  // 软链逃逸：realpath 后落在目录外，拒绝
  const link = spawnSync('bash', ['-c', harness(path.join(backupDir, 'escape.db'))], { encoding: 'utf8' });
  assert.ok(!link.stdout.includes('RESTORE_CALLED'), '软链逃逸不得恢复');
});

test('diting.sh 语法通过；恢复审计锚点不被破坏', () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `bash -n 失败：${r.stderr}`);
  assert.match(applyBody, /cp "\$restore_src"/, '未压缩备份复制后再写标记的行为保留（restore-audit 锚点）');
  assert.match(applyBody, /ensure_docker_if_volume/, '按库形态判定 Docker 依赖（native-backup 锚点）');
});
