'use strict';
// ============================================================
// 回归守卫：`diting.sh --update-server` 的升级安全网（T1.10）。
//
// 旧实现三处缺口：
//   1) 直接 `git reset --hard` + `compose down`，**没有备份**——升级炸了数据也没了；
//   2) `up -d --build` 返回 0 就打印"已更新"，容器创建成功≠进程活着；
//   3) 没有 `--force` 解析，失败后没有任何跳过手段。
//
// 顺序约束（关键）：备份必须在 `compose down` **之前**。locate_db 的 docker 分支
// 依赖 `docker ps` 找到携带 server-data 卷的容器，容器一停就定位不到库，
// `do_backup` 只会返回 "cannot locate database"。
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

const UPDATE = fnBody('update_server');

test('update_server：备份发生在 compose down 之前', () => {
  const iBackup = UPDATE.indexOf('do_backup "$_bak" 0');
  const iDown = UPDATE.indexOf('docker compose down');
  assert.notStrictEqual(iBackup, -1, '应调用 do_backup "$_bak" 0');
  assert.notStrictEqual(iDown, -1, '应调用 docker compose down');
  assert.ok(iBackup < iDown,
    'do_backup 必须在 compose down 之前：容器停掉后 locate_db 找不到数据库，备份必然失败');
});

test('update_server：备份成功后回读真实产物名（压缩会把 .db 换成 .db.gz）', () => {
  // do_backup 压缩成功后删除原文件、只留 <path>.gz。若不回读，后面的
  // 「升级前备份」提示与 _upgrade_rollback_hint 的 --restore 命令都指向
  // 一个不存在的路径，用户照抄会失败（j4125 真机验收实测踩中）。
  assert.match(UPDATE, /\[\[ -f "\$\{_bak\}\.gz" && ! -f "\$_bak" \]\] && _bak="\$\{_bak\}\.gz"/,
    '应在备份成功后把 _bak 改写成真实的 .gz 产物名');
  // 回滚提示与收尾提示必须用同一个 _bak（改写后的值）
  const iRewrite = UPDATE.indexOf('_bak="${_bak}.gz"');
  const iHint = UPDATE.indexOf('_upgrade_rollback_hint "${_old:-}" "$_bak"');
  assert.ok(iRewrite !== -1 && iHint !== -1 && iRewrite < iHint,
    '回滚提示必须发生在路径改写之后，才能拿到真实文件名');
});

test('update_server：备份失败默认中止，只有 --force 才继续', () => {
  assert.match(UPDATE, /if do_backup "\$_bak" 0; then/);
  assert.match(UPDATE, /\[\[ "\$\{A_FORCE:-0\}" == "1" \]\]/, '应以 A_FORCE 判定是否放行');
  assert.match(UPDATE, /升级前备份失败，已中止升级/, '应给出明确的失败文案');
  assert.match(UPDATE, /--force/, '应提示可用 --force 跳过');
});

test('update_server：重建后校验容器真的在运行，失败给回滚提示', () => {
  const iUp = UPDATE.indexOf('docker compose up -d --build');
  const iCheck = UPDATE.indexOf('{{.State.Running}}');
  assert.notStrictEqual(iUp, -1);
  assert.notStrictEqual(iCheck, -1, '应以容器运行状态校验替代"up 返回 0 即成功"');
  assert.ok(iCheck > iUp, '状态校验应在重建之后');
  assert.ok(UPDATE.includes('_upgrade_rollback_hint'), '失败时应打印回滚提示');
  // 回滚提示要同时给出代码与数据两条命令
  const HINT = fnBody('_upgrade_rollback_hint');
  assert.match(HINT, /--restore/, '应提示用备份恢复数据');
  assert.match(HINT, /git -C \$\{SRC_DIR\} reset --hard/, '应提示回退代码');
});

test('--force：解析存在且重新 exec 时会传下去', () => {
  assert.match(src, /--force\)\s+A_FORCE=1; shift ;;/, '应解析 --force');
  assert.match(src, /exec bash "\$SRC_DIR\/diting\.sh" --update-server --force/,
    '重新加载新脚本时必须带 --force，否则新进程会再次因备份失败中止');
  assert.match(src, /SP_REEXECED=1 exec bash "\$SRC_DIR\/diting\.sh" --update-server\n/,
    '不带 --force 的分支应保持原调用形式');
});

test('diting.sh 语法校验通过', () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `bash -n 失败：${r.stderr}`);
});
