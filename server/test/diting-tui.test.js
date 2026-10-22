'use strict';
// ============================================================
// 回归守卫：交互层改为纯文本（附录 B / T1.11）。
//
// 改造前的问题：
//   1) 装了 graphic 库和没装，走两套渲染路径，行为/输出不一致；
//   2) `read ... || exit 0`：管道耗尽被当成"用户主动退出"，CI 里静默成功；
//   3) 颜色恒定赋值，`--status | cat` 会混入 ANSI 转义。
//
// 这里既做静态断言（关键字清零、颜色按 TTY 判定），也**真跑**提取出来的函数体
// 验证 EOF / 空回车 / yes 三种输入下的返回码。
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

function runFn(name, extra, input) {
  const code = `set -u; BLUE=''; NC=''\n${fnBody(name)}\n${extra}`;
  return spawnSync('bash', ['-c', code], { input, encoding: 'utf8' });
}

test('交互层：图形库关键字与旧变量彻底移除（装没装软件包行为一致）', () => {
  assert.strictEqual((src.match(/whiptail|dialog/g) || []).length, 0, '不应再出现图形菜单相关关键字');
  assert.strictEqual((src.match(/UI_BIN/g) || []).length, 0, '不应再有 UI_BIN 分支变量');
  assert.strictEqual((src.match(/tui\./g) || []).length, 0, 'tui.* 文案键应随图形菜单一并删除');
});

test('颜色：按 stdout 是否 TTY 决定，管道下必须为空', () => {
  assert.match(src, /if \[\[ -t 1 \]\]; then[\s\S]{0,200}RED=\$'\\033\[0;31m'/, '颜色应在 [-t 1] 分支内');
  assert.match(src, /else\n\s*RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''\nfi/, '非 TTY 分支应全部置空');
});

test('ui_menu：EOF → 返回非零（不能把管道耗尽当成"用户退出"）', () => {
  const r = runFn('ui_menu', 'ui_menu "" "选择" "1" "选项一"; echo "rc=$?"', '');
  assert.match(r.stdout, /rc=1/, `EOF 应返回 1，实际输出：${r.stdout}`);
  const ok = runFn('ui_menu', 'ui_menu "" "选择" "1" "选项一"; echo "rc=$?"', '1\n');
  assert.match(ok.stdout, /1\nrc=0/, '正常输入应回显 tag 且返回 0');
});

test('ui_confirm：空回车 = 取消（安全优先，卸载/重置不得因误回车执行）', () => {
  const empty = runFn('ui_confirm', 'ui_confirm "t" "确定？"; echo "rc=$?"', '\n');
  assert.match(empty.stdout, /rc=1/, '空回车必须是"否"');
  const eof = runFn('ui_confirm', 'ui_confirm "t" "确定？"; echo "rc=$?"', '');
  assert.match(eof.stdout, /rc=1/, 'EOF 必须是"否"');
  for (const yes of ['y\n', 'Y\n', 'yes\n']) {
    const r = runFn('ui_confirm', 'ui_confirm "t" "确定？"; echo "rc=$?"', yes);
    assert.match(r.stdout, /rc=0/, `${JSON.stringify(yes)} 应视为确认`);
  }
  assert.match(fnBody('ui_confirm'), /local _title="\$1" text="\$2"/, '应保留 (标题, 提示) 旧签名，避免改动全部调用点');
});

test('ui_prompt：空输入取默认值，EOF 返回非零', () => {
  const def = runFn('ui_prompt', 'ui_prompt "t" "端口" "8081"; echo "rc=$?"', '\n');
  assert.match(def.stdout, /8081\nrc=0/, '空回车应回显默认值');
  const eof = runFn('ui_prompt', 'ui_prompt "t" "端口" "8081"; echo "rc=$?"', '');
  assert.match(eof.stdout, /rc=1/, 'EOF 应返回 1');
});

test('主菜单循环：EOF 非零退出、空回车重绘而非退出', () => {
  assert.match(src, /\|\| exit 1\s*\n\s*# 空回车/, 'EOF 应 exit 1');
  assert.match(src, /\[\[ -z "\$c" \]\] && return/, '空回车应 return 到菜单循环重绘');
  assert.ok(!/\[\[ -z "\$c" \]\] && exit 0/.test(src), '不应再出现"空输入→exit 0"');
});
