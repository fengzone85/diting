'use strict';
// ============================================================
// G1（REL-06a）：heavyQuery worker 超时先 terminate 再主线程 fallback。
// 旧码超时仅 reject，worker 里的同步查询仍跑完（僵尸）+ 主线程 fallback 再跑
// 一遍＝双执行。修复：超时回调先 worker.terminate() 杀死僵尸查询再 reject。
// 本文件直接驱动 db / heavy-db，不起 HTTP 服务器。
// ============================================================
process.env.DB_PATH = '/tmp/diting-audit-g-heavy-timeout.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const wt = require('node:worker_threads');

for (const s of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + s); } catch { /* 不存在则忽略 */ }
}

const db = require('../src/db');

const id = db.createAgent({ name: 'g1-node' }).id;
for (const off of [60000, 30000]) {
  db.insertMetric(id, {
    ts: Date.now() - off, cpu: 5, mem_used: 1, mem_total: 2, mem_pct: 50,
    disk_used: 1, disk_total: 2, disk_pct: 50, load1: 0, load5: 0, load15: 0,
    net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0,
    uptime: 10, process_count: 1,
    probes: JSON.stringify({ CM: { ms: 12.5, ok: true, loss: 0 } }),
  });
}

//  spies：Worker 构造计数（证 respawn）、terminate 计数（证僵尸被杀）、fallback 计数。
const OrigWorker = wt.Worker;
let spawns = 0;
let terminates = 0;
const origTerminate = OrigWorker.prototype.terminate;
OrigWorker.prototype.terminate = function (...a) { terminates++; return origTerminate.apply(this, a); };
wt.Worker = class extends OrigWorker { constructor(...a) { spawns++; super(...a); } };

let syncCalls = 0;
const origSync = db.heavyQuerySync;
db.heavyQuerySync = function (...a) { syncCalls++; return origSync.apply(this, a); };

// 1ms 超时强制走回退；空闲回收拉到 60s 避免干扰 terminate 计数。
const mod = require.resolve('../src/heavy-db');
delete require.cache[mod];
process.env.HEAVY_QUERY_TIMEOUT_MS = '1';
process.env.HEAVY_WORKER_IDLE_MS = '60000';
const fresh = require('../src/heavy-db');

after(() => {
  fresh.stop();
  wt.Worker = OrigWorker;
  OrigWorker.prototype.terminate = origTerminate;
  db.heavyQuerySync = origSync;
  delete process.env.HEAVY_QUERY_TIMEOUT_MS;
  delete process.env.HEAVY_WORKER_IDLE_MS;
  delete require.cache[mod];
  require('../src/heavy-db'); // 放回默认配置实例，避免影响后续文件
  for (const s of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + s); } catch { /* 忽略 */ }
  }
});

test('G1 超时先 terminate worker 再主线程 fallback（消除双执行）', async () => {
  const since = Date.now() - 3600000;
  const expected = db.metricsProbesAll(since, 100);
  assert.ok(expected.length > 0, '前置：应有非空探针数据');
  const rows = await fresh.heavyQuery('probesAll', since, 100);
  assert.ok(terminates >= 1, '超时必须 terminate worker 杀死僵尸查询（负向对照：旧码超时不 terminate）');
  assert.strictEqual(syncCalls, 1, '主线程 fallback 恰执行 1 次');
  assert.deepStrictEqual(rows, expected, 'fallback 结果仍正确');
});

test('G1 超时后 worker 置 null，下次查询自动 respawn', async () => {
  const since = Date.now() - 3600000;
  const spawnsBefore = spawns;
  await fresh.heavyQuery('probesAll', since, 100);
  assert.ok(spawns > spawnsBefore, '超时已置 worker=null，本次查询应 respawn 新 worker（负向对照：旧码复用僵尸 worker）');
});