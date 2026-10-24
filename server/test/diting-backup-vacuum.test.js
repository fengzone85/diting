'use strict';
// ============================================================
// F8.1 回归：宿主备份不得对运行中的库直接 cp
//
// 背景（IMPLEMENTATION_PLAN_2026-10-19 §5 F8.1，2026-10-24 审查）：
//   rollback journal 模式下提交是「写 journal → 改页 → 删 journal」，
//   对正在写入的库做文件级 cp 会拷到半提交状态；旧实现注释写「需先 flush」，
//   代码里既无 flush 也无 checkpoint、更未停服。
//
// 锚定行为：
//   1. do_backup 的宿主机分支优先 `sqlite3 VACUUM INTO`（一致性快照）；
//   2. 无 sqlite3 时回退服务端 better-sqlite3 在线快照（db_run_js），
//      不是 cp；
//   3. 两条路径都失败时必须中止（return 1），不得静默退化热 cp；
//   4. 脚本语法仍通过 `bash -n`。
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

test('F8.1：宿主分支用 VACUUM INTO，且不存在对运行中库的直接 cp', () => {
  const body = fnBody('do_backup');
  assert.match(body, /VACUUM INTO/, '宿主分支必须用 VACUUM INTO 生成一致性快照');
  assert.ok(!/cp "\$fpath" "\$out_path"/.test(body), '不得直接 cp "$fpath" "$out_path"（热 cp 半提交风险）');
});

test('F8.1：无 sqlite3 时回退 better-sqlite3 在线快照，失败即中止', () => {
  const body = fnBody('do_backup');
  assert.match(body, /db_run_js "\$bak_js" "\$out_path"/, '回退路径应走 db_run_js（better-sqlite3 在线备份）');
  assert.match(body, /不回退热 cp/, '错误提示必须写明不回退热 cp');
  assert.match(body, /db_backup_state_set last_status=failed/, '失败时应落备份状态，供后台展示');
  // 两条路径均以 return 1 收尾（VACUUM 失败 / 在线快照失败）
  const aborts = body.match(/return 1/g) || [];
  assert.ok(aborts.length >= 2, `宿主备份失败路径应有 ≥2 处 return 1，实际 ${aborts.length}`);
});

test('F8.1：diting.sh 语法校验通过', () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `bash -n 失败：${r.stderr}`);
});
