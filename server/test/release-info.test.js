'use strict';
// S5.3-4 release-info：受控端最新 tag 查询（6h 缓存 / 失败负缓存 / 后台刷新 / in-flight 去重）
process.env.PORT = '0';
process.env.DB_PATH = '/tmp/diting-release-info-test.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const info = require('../src/release-info');

after(() => {
  info._test.reset();
  info._test.setFetcher(null);
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

test('S5.3-4 命中缓存：TTL 内不重复打上游', async () => {
  let calls = 0;
  info._test.setFetcher(async () => {
    calls++;
    return { status: 200, body: Buffer.from(JSON.stringify({ tag_name: 'agent-go-v9.9.9' })) };
  });
  const tag = await info._test.refreshNow();
  assert.strictEqual(tag, 'agent-go-v9.9.9');
  assert.strictEqual(info.latestAgentTag(), 'agent-go-v9.9.9');
  assert.strictEqual(info.latestAgentTag(), 'agent-go-v9.9.9');
  assert.strictEqual(calls, 1, 'TTL 内只允许一次上游调用');
});

test('S5.3-4 上游失败：返回 null 且进入负缓存（不每请求重试）', async () => {
  let calls = 0;
  info._test.setFetcher(async () => { calls++; throw new Error('network down'); });
  const tag = await info._test.refreshNow();
  assert.strictEqual(tag, null);
  assert.strictEqual(info.latestAgentTag(), null);
  assert.strictEqual(info.latestAgentTag(), null);
  assert.strictEqual(calls, 1, '负缓存期内不得重复打上游');
});

test('S5.3-4 HTTP 非 200 同样视为失败（不把错误页当版本号）', async () => {
  info._test.setFetcher(async () => ({ status: 503, body: Buffer.from('service unavailable') }));
  assert.strictEqual(await info._test.refreshNow(), null);
  assert.strictEqual(info.latestAgentTag(), null);
});

test('S5.3-4 冷启动不阻塞：首次同步返回 null，后台刷新后可见', async () => {
  info._test.reset();
  info._test.setFetcher(async () => ({ status: 200, body: Buffer.from(JSON.stringify({ tag_name: 'agent-go-v1.2.3' })) }));
  assert.strictEqual(info.latestAgentTag(), null, '冷启动同步返回 null，不阻塞 /api/version');
  const tag = await info._test.refreshNow();
  assert.strictEqual(tag, 'agent-go-v1.2.3');
  assert.strictEqual(info.latestAgentTag(), 'agent-go-v1.2.3');
});

test('S5.3-4 并发去重：同时刷新只打一次上游', async () => {
  let calls = 0;
  info._test.reset();
  info._test.setFetcher(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return { status: 200, body: Buffer.from(JSON.stringify({ tag_name: 'agent-go-v2.0.0' })) };
  });
  const [a, b] = await Promise.all([info._test.refreshNow(), info._test.refreshNow()]);
  assert.strictEqual(a, 'agent-go-v2.0.0');
  assert.strictEqual(b, 'agent-go-v2.0.0');
  assert.strictEqual(calls, 1, '并发刷新应合并为一次上游调用');
});
