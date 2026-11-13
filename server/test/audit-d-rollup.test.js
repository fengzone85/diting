'use strict';
// ============================================================
// 外部审查复核 Batch D：D2 rollup runOnce 单飞（重叠触发跳过）。
// 负向对照：git show HEAD:server/src/rollup.js 旧版跑本文件应失败。
// ============================================================
process.env.DB_PATH = '/tmp/diting-audit-d-rollup.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const db = require('../src/db');
const rollup = require('../src/rollup');

after(() => {
  rollup.stop();
  db.flushTraffic();
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

const H = rollup.HOUR;

test('D2 并发触发：第二个 runOnce 跳过，首个完成且无重复折叠', async () => {
  const agentId = db.createAgent({ name: 'd2-agent' }).id;
  // 30 个已封口小时（>24 才能触发让出点，重叠窗口真实存在）
  const start = rollup.hourStart(Date.now() - 33 * H);
  for (let i = 0; i < 30; i++) {
    db.insertMetric(agentId, {
      ts: start + i * H + 60000, cpu: 1, mem_used: 1, mem_total: 10, mem_pct: 10,
      disk_used: 1, disk_total: 10, disk_pct: 10, load1: 0, load5: 0, load15: 0,
      net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0,
      uptime: 0, process_count: 0,
    });
  }

  const p1 = rollup.runOnce();
  const p2 = rollup.runOnce(); // p1 在 24 折处让出事件循环，此刻仍 in-flight
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r2.skipped, true, '重叠触发应直接跳过');
  assert.strictEqual(r2.folded, 0);
  assert.ok(r1.folded >= 24, `首个调用应真实折叠（got ${r1.folded}）`);

  const hours = db.db.prepare('SELECT COUNT(*) AS c FROM metrics_hour WHERE agent_id = ?').get(agentId).c;
  assert.strictEqual(hours, 30, '每小时恰好一行，无重复折叠');

  const r3 = await rollup.runOnce();
  assert.ok(!r3.skipped, '完成后标志应复位');
  assert.strictEqual(r3.folded, 0, '水位线已推进，无剩余可折');
});