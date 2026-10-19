'use strict';
// ============================================================
// 安全审查修复（第三批，P3）的回归断言（SECURITY_REVIEW_2026-10-17.md 行动计划）
//
// 锚定修复的行为：
//   C4 — heavyQuery 的 worker 结果与主线程同步路径一致（正确性）；
//         worker 超时后自动回退主线程（可用性兜底）；
//         heavyQuerySync 回退入口与委托路径一致、未知函数报错。
// 本文件不需要 HTTP 服务器，直接驱动 db / heavy-db。
// ============================================================
process.env.DB_PATH = '/tmp/diting-security-fixes-p3-test.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const db = require('../src/db');
const { heavyQuery, stop } = require('../src/heavy-db');

after(() => {
  stop(); // 终止 worker，避免悬挂线程拖住测试进程
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

test('heavyQuery：worker 线程结果与主线程同步路径一致（C4 正确性）', async () => {
  const since = Date.now() - 3600000;
  const w1 = await heavyQuery('probesAll', since, 100);
  const s1 = db.metricsProbesAll(since, 100);
  assert.deepStrictEqual(w1, s1, 'probesAll：worker 与主线程应一致');

  const w2 = await heavyQuery('sparklinesAllSampled', since, 100);
  const s2 = db.metricsSparklinesAllSampled(since, 100);
  assert.deepStrictEqual(w2, s2, 'sparklinesAllSampled：worker 与主线程应一致');

  const w3 = await heavyQuery('loadAll', since, 100);
  const s3 = db.getMetricsLoadAll(since, 100);
  assert.deepStrictEqual(w3, s3, 'loadAll：worker 与主线程应一致');

  const w4 = await heavyQuery('clusterAvg', since, 3600000, 100);
  const s4 = db.metricsClusterAvg(since, 3600000, 100);
  assert.deepStrictEqual(w4, s4, 'clusterAvg：worker 与主线程应一致');

  const w5 = await heavyQuery('diskTrendAll', since, 3600000);
  const s5 = db.metricsDiskTrendAll(since, 3600000);
  assert.deepStrictEqual(w5, s5, 'diskTrendAll：worker 与主线程应一致');
});

test('heavyQuerySync：主线程回退入口与委托路径一致；未知函数报错', () => {
  const since = Date.now() - 3600000;
  assert.deepStrictEqual(db.heavyQuerySync('probesAll', [since, 100]), db.metricsProbesAll(since, 100));
  assert.deepStrictEqual(db.heavyQuerySync('loadAll', [since, 100]), db.getMetricsLoadAll(since, 100));
  assert.throws(() => db.heavyQuerySync('nope', []), /unknown heavy fn/);
});

test('heavyQuery：worker 超时后回退主线程，结果仍正确（C4 可用性兜底）', async () => {
  // 以 1ms 超时强制走回退路径（worker 里的查询仍会跑完，结果丢弃——同步查询
  // 无法中断，此为已知限制；超时值可经 HEAVY_QUERY_TIMEOUT_MS 调整）。
  const mod = require.resolve('../src/heavy-db');
  delete require.cache[mod];
  process.env.HEAVY_QUERY_TIMEOUT_MS = '1';
  const fresh = require('../src/heavy-db');
  try {
    const since = Date.now() - 3600000;
    const rows = await fresh.heavyQuery('probesAll', since, 100);
    assert.deepStrictEqual(rows, db.metricsProbesAll(since, 100), '回退后结果应仍正确');
  } finally {
    fresh.stop();
    delete process.env.HEAVY_QUERY_TIMEOUT_MS;
    delete require.cache[mod];
    // 缓存中放回默认配置实例，避免影响后续文件
    require('../src/heavy-db');
  }
});
