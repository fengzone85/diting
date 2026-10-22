'use strict';
// ============================================================
// 回归守卫：REPO_BRANCH 必须真的能钉住源码版本。
//
// 旧实现只在 `REPO_RAW`（脚本/载荷的 raw 下载地址）里用了 REPO_BRANCH，
// 源码同步全部写死 master：
//   git fetch origin master / git reset --hard origin/master / git clone（不带 -b）
// 于是 `REPO_BRANCH=v1.2.0 sudo bash diting.sh --install-server` 装出来的
// 仍是 master 源码 —— 与注释"可钉 tag，便于可复现安装"的承诺相反。
//
// 这里既做静态断言，也**真跑** clone -b 与 sync_source_ref（用临时 git 仓库）。
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

function sh(code, opts = {}) {
  return spawnSync('bash', ['-c', code], { encoding: 'utf8', ...opts });
}

test('静态：源码同步不再写死 master', () => {
  // 注释里保留"旧实现是 xxx"的说明是允许的，只检查可执行代码行
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/fetch origin master/.test(code), '不应再有 `fetch origin master`');
  assert.ok(!/reset --hard origin\/master/.test(code), '不应再有 `reset --hard origin/master`');
  assert.ok(!/checkout -B master -f origin\/master/.test(code), '非 git 改造路径也不该写死 master');
  assert.match(code, /git clone --depth 1 -b "\$REPO_BRANCH"/, 'clone 必须带 -b "$REPO_BRANCH"');
  assert.strictEqual((code.match(/sync_source_ref/g) || []).length >= 3, true,
    'fetch/reset 的三处（安装器 1 + 更新器 2）应统一走 sync_source_ref');
});

test('sync_source_ref：fetch + reset FETCH_HEAD，对分支与 tag 都成立', () => {
  const body = fnBody('sync_source_ref');
  assert.match(body, /fetch origin "\$ref"/);
  assert.match(body, /reset --hard FETCH_HEAD/, 'tag 场景下没有 origin/<tag> 分支，必须用 FETCH_HEAD');
  assert.match(body, /branch -u "origin\/\$ref" 2>\/dev\/null \|\| true/, '设上游失败（tag）应忽略');
});

test('真跑：clone -b 与 sync_source_ref 能切到指定分支', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-ref-'));
  const origin = path.join(tmp, 'origin');
  const work = path.join(tmp, 'work');
  try {
    const setup = sh(`
      set -e
      mkdir -p '${origin}' && cd '${origin}'
      git init -q -b master .
      git config user.email t@t.local && git config user.name t
      echo master > f.txt && git add . && git commit -qm m
      git checkout -qb pinned && echo pinned > f.txt && git commit -qam p
      git checkout -q master
      cd '${tmp}' && git clone -q '${origin}' '${work}'
    `);
    assert.strictEqual(setup.status, 0, `准备仓库失败：${setup.stderr}`);
    assert.strictEqual(fs.readFileSync(path.join(work, 'f.txt'), 'utf8').trim(), 'master');

    const run = sh(`
      set -u
      SRC_DIR='${work}'
      ${fnBody('sync_source_ref')}
      sync_source_ref pinned && echo "RC=0"
      cat "${work}/f.txt"
    `);
    assert.strictEqual(run.status, 0, `sync_source_ref 失败：${run.stderr}`);
    assert.match(run.stdout, /RC=0/);
    assert.match(run.stdout, /pinned/, '工作树应切到 pinned 分支的内容');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('真跑：clone -b 一个不存在的引用会失败（不再静默装成 master）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-ref-'));
  const origin = path.join(tmp, 'origin');
  try {
    sh(`mkdir -p '${origin}' && cd '${origin}' && git init -q -b master . && git config user.email t@t.local && git config user.name t && echo a > f && git add . && git commit -qm m`);
    const r = sh(`cd '${tmp}' && git clone --depth 1 -b no-such-ref '${origin}' dest 2>&1`);
    assert.notStrictEqual(r.status, 0, '不存在的分支必须失败');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diting.sh 语法校验通过', () => {
  const r = sh(`bash -n '${SCRIPT}'`);
  assert.strictEqual(r.status, 0, `bash -n 失败：${r.stderr}`);
});
