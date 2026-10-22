'use strict';
// ============================================================
// 回归守卫：diting.sh 中 db_run_js 的模块解析落点（T0.0 / G1 / M1）
//
// 背景：node 的模块解析以「脚本所在目录」为根。db_run_js 原先把脚本落到
//   - 运行中容器：/tmp/diting_db.js   → 解析根 /tmp，找不到 /app/node_modules
//   - 仅卷存在：  /host_js/$jsname     → 解析根 /host_js，同上
//   - 宿主机文件：mktemp 目录          → 解析根 /tmp，同上
// 三种形态一律 require('better-sqlite3') MODULE_NOT_FOUND。由于调用点多带
// `2>/dev/null || true`，该缺陷长期静默：备份保留天数、压缩开关、备份周期
// 一直按默认值走，从未读到过后台配置。
//
// 本测试做两件事：
//   1) 静态断言 diting.sh 源码里不再出现 /tmp 落点，且三个分支各自具备
//      正确的解析前提（/app 落点 / NODE_PATH）；
//   2) 功能断言「NODE_PATH 指向服务端 node_modules 后，脚本放在 /tmp 也能
//      解析到 better-sqlite3」——即修复所依赖的机制本身成立。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'diting.sh');
const SERVER_NM = path.join(__dirname, '..', 'node_modules');

const src = fs.readFileSync(SCRIPT, 'utf8');

// 取出 db_run_js 函数体（含 server_node_modules 辅助函数）
function fnBody(name) {
  const start = src.indexOf(`${name}() {`);
  assert.notStrictEqual(start, -1, `diting.sh 应包含 ${name}() 定义`);
  // 顶层函数的收尾是行首的 '}'（列 0）
  const end = src.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `未能定位 ${name}() 的函数体结尾`);
  return src.slice(start, end + 3);
}

test('diting.sh: db_run_js 不再把脚本落到 /tmp', () => {
  const body = fnBody('db_run_js');
  assert.ok(
    !/\/tmp\/diting_db\.js/.test(src),
    'diting.sh 仍存在 /tmp/diting_db.js 落点（node 解析根为 /tmp → MODULE_NOT_FOUND）'
  );
  assert.ok(
    body.includes('/app/diting_db.js'),
    '运行中容器分支应把脚本落到 /app（镜像 WORKDIR，依赖在 /app/node_modules）'
  );
});

test('diting.sh: 三个形态各自具备模块解析前提', () => {
  const body = fnBody('db_run_js');
  // 仅卷存在分支：脚本挂 /host_js（只读），必须给容器补 NODE_PATH
  assert.ok(
    body.includes('-e NODE_PATH=/app/node_modules'),
    '仅卷存在分支应给 docker run 补 -e NODE_PATH=/app/node_modules'
  );
  // 宿主机分支：脚本在 mktemp 目录，必须用 NODE_PATH 指向服务端 node_modules
  assert.ok(
    body.includes('NODE_PATH="$nm"'),
    '宿主机分支应以 NODE_PATH 指向服务端 node_modules 执行'
  );
  assert.ok(
    body.includes('server_node_modules'),
    '宿主机分支应通过 server_node_modules 定位依赖目录'
  );
  // 辅助函数本身：候选路径里必须包含服务端 node_modules
  const helper = fnBody('server_node_modules');
  assert.ok(helper.includes('node_modules'), 'server_node_modules 应定位 node_modules 目录');
  assert.ok(helper.includes('better-sqlite3'), 'server_node_modules 应校验 better-sqlite3 存在');
});

test('机制验证：NODE_PATH 指向服务端依赖后，/tmp 中的脚本可解析 better-sqlite3', () => {
  if (!fs.existsSync(path.join(SERVER_NM, 'better-sqlite3'))) {
    // CI 未安装依赖时跳过（npm install 后本用例即生效）
    assert.ok(true, '跳过：server/node_modules/better-sqlite3 未安装');
    return;
  }
  const js = "require('better-sqlite3'); console.log('resolve-ok')";
  const ok = spawnSync('node', ['-e', js], {
    cwd: '/tmp',
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: SERVER_NM },
  });
  assert.strictEqual(ok.status, 0, `NODE_PATH 兜底后仍解析失败：${ok.stderr}`);
  assert.match(ok.stdout, /resolve-ok/);

  // 反向对照：不带 NODE_PATH 时应当解析失败（若本机恰好装了全局副本则跳过该断言）
  const bad = spawnSync('node', ['-e', js], {
    cwd: '/tmp',
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
  if (bad.status !== 0) {
    assert.match(bad.stderr, /Cannot find module 'better-sqlite3'/);
  }
});
