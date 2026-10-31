'use strict';
// ============================================================
// 行为测试：AI Key 的 env 模式口径（审查修复 P1-3）
//
// 三层都要验，缺一层就会出现「切到 env 模式后残留又复活」：
//   1. db.setAiConfig —— 存储层剔除
//   2. db.clearAiApiKey —— 显式清理历史残留
//   3. server.js 启动兜底 —— 只在 env 模式清、无残留时零日志零写入
//
// 全部用独立子进程 + 临时库，避免污染集成测试共享的 DB_PATH 与 process.env。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');
const DB_SRC = path.join(SERVER_DIR, 'src', 'db');
const SERVER_SRC = path.join(SERVER_DIR, 'server');

function runProbe(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-aikey-'));
  const file = path.join(dir, 'probe.js');
  fs.writeFileSync(file, source);
  const env = { ...process.env };
  delete env.AI_KEY_FROM_ENV;
  delete env.AI_API_KEY;
  const r = spawnSync(process.execPath, [file], {
    cwd: SERVER_DIR, encoding: 'utf8', env, timeout: 20000,
  });
  return r;
}

function out(r) {
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT:'));
  assert.ok(line, `子进程未输出结果。stdout=${r.stdout}\nstderr=${r.stderr}`);
  return JSON.parse(line.slice(4));
}

test('存储层：env 模式写入剔除 api_key，非 env 模式正常保留', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diting-aikey-db-')), 'm.db');
  const r = runProbe(`
process.env.DB_PATH = ${JSON.stringify(dbPath)};
const db = require(${JSON.stringify(DB_SRC)});
db.setConfig('ai_config', JSON.stringify({ enabled: true, model: 'gpt-4o-mini', api_key: 'sk-plain-old' }));

process.env.AI_KEY_FROM_ENV = '1';
db.setAiConfig({ api_key: 'sk-plain-new', model: 'gpt-4o' });
const afterEnv = JSON.parse(db.getConfig('ai_config'));

process.env.AI_KEY_FROM_ENV = '0';
db.setAiConfig({ api_key: 'sk-kept' });
const afterDb = JSON.parse(db.getConfig('ai_config'));

process.stdout.write('OUT:' + JSON.stringify({ afterEnv, afterDb }) + '\\n');
`);
  assert.strictEqual(r.status, 0, r.stderr);
  const { afterEnv, afterDb } = out(r);
  assert.ok(!('api_key' in afterEnv), 'env 模式下不得落库 api_key');
  assert.strictEqual(afterEnv.model, 'gpt-4o', '其他字段应正常保存');
  assert.strictEqual(afterEnv.enabled, true, '既有字段不得丢失');
  assert.strictEqual(afterDb.api_key, 'sk-kept', '非 env 模式应恢复可写');
});

test('清理函数：clearAiApiKey 删除残留并返回是否命中', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diting-aikey-db-')), 'm.db');
  const r = runProbe(`
process.env.DB_PATH = ${JSON.stringify(dbPath)};
const db = require(${JSON.stringify(DB_SRC)});
db.setConfig('ai_config', JSON.stringify({ enabled: true, model: 'x', api_key: 'sk-historical' }));
const removed = db.clearAiApiKey();
const after = JSON.parse(db.getConfig('ai_config'));
const again = db.clearAiApiKey();
process.stdout.write('OUT:' + JSON.stringify({ removed, again, after }) + '\\n');
`);
  assert.strictEqual(r.status, 0, r.stderr);
  const { removed, again, after } = out(r);
  assert.strictEqual(removed, true, '有残留时应返回 true');
  assert.ok(!('api_key' in after), '残留应被删除');
  assert.strictEqual(after.model, 'x', '其他字段不得被清');
  assert.strictEqual(again, false, '无残留时应返回 false（幂等）');
});

test('启动兜底：env 模式启动时清除历史明文并告警', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diting-aikey-db-')), 'm.db');
  const r = runProbe(`
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.DB_PATH = ${JSON.stringify(dbPath)};
process.env.AI_KEY_FROM_ENV = '1';
const db = require(${JSON.stringify(DB_SRC)});
db.setConfig('ai_config', JSON.stringify({ enabled: false, api_key: 'sk-historical-plain' }));
const { server } = require(${JSON.stringify(SERVER_SRC)});
const after = JSON.parse(db.getConfig('ai_config'));
process.stdout.write('OUT:' + JSON.stringify({ hasKey: Object.prototype.hasOwnProperty.call(after, 'api_key'), enabled: after.enabled }) + '\\n');
server.close(() => process.exit(0));
setTimeout(() => process.exit(0), 2000).unref();
`);
  assert.strictEqual(r.status, 0, r.stderr);
  const res = out(r);
  assert.strictEqual(res.hasKey, false, '启动后库中不应再有明文 key');
  assert.strictEqual(res.enabled, false, 'AI 其他配置不得被改动');
  assert.match(r.stderr, /已清除数据库中的明文 api_key/, '应打印清理告警');
});

test('启动兜底：非 env 模式零写入、零告警（不污染集成测试输出）', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diting-aikey-db-')), 'm.db');
  const r = runProbe(`
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.DB_PATH = ${JSON.stringify(dbPath)};
const db = require(${JSON.stringify(DB_SRC)});
db.setConfig('ai_config', JSON.stringify({ enabled: true, api_key: 'sk-still-in-use' }));
const { server } = require(${JSON.stringify(SERVER_SRC)});
const after = JSON.parse(db.getConfig('ai_config'));
process.stdout.write('OUT:' + JSON.stringify({ key: after.api_key }) + '\\n');
server.close(() => process.exit(0));
setTimeout(() => process.exit(0), 2000).unref();
`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(out(r).key, 'sk-still-in-use', '非 env 模式不得清理既有 key');
  assert.doesNotMatch(r.stderr, /已清除数据库中的明文 api_key/, '非 env 模式不应打印清理日志');
});
