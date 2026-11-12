'use strict';
// ============================================================
// P0-3 回归：采样与可用率口径（三处联合）。
//
// 修前缺陷链：
//   1. rollup `p.ok !== false` 把 ok:null 计成功 → 全 null 小时 n_ok=n/n_samp=0，
//      合并层折出 ok:true/loss:0，可用率被系统性抬高；
//   2. finishProbe 混合桶「任一成功即 100%」；
//   3. 可用率按桶等权（1 样本桶与 100 样本桶同权）、降采样同病。
//
// 锚定行为：
//   - foldProbes：只有 ok===true 计 nOk，n_samp 只数布尔样本；
//   - 合并输出透传 n_ok/n_samp/ok_rate，ok/loss 保留兼容语义；
//   - 可用率 = Σn_ok/Σn_samp 加权；全 null 时段可用率为 null，不显示 100%。
// ============================================================
process.env.PORT = '0';
process.env.DB_PATH = '/tmp/diting-metrics-availability-test.db';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'metrics-availability-admin-token-0123456789';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const rollup = require('../src/rollup');

after(async () => {
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  rollup.stop();
  db.flushTraffic();
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

const H = 3600 * 1000;
const MIN = 60 * 1000;

function metric(agentId, ts, probesObj) {
  db.insertMetric(agentId, {
    ts, cpu: 0, mem_used: 0, mem_total: 0, mem_pct: 0,
    disk_used: 0, disk_total: 0, disk_pct: 0, load1: 0, load5: 0, load15: 0,
    net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0,
    uptime: 0, process_count: 0,
    probes: JSON.stringify(probesObj),
  });
}

test('P0-3 foldProbes：ok:null 不计成功，n_ok/n_samp 只数布尔样本', () => {
  const rows = [1, 2, 3, 4].map((i) => ({
    agent_id: 'a', ts: i,
    probes: JSON.stringify({ t: { ms: null, ok: null, loss: null } }),
  }));
  rows[2].probes = JSON.stringify({ t: { ms: 5, ok: true, loss: 0 } });
  rows[3].probes = JSON.stringify({ t: { ms: null, ok: false, loss: 100 } });

  const out = rollup.foldProbes(rows);
  const p = out.get('a').t;
  assert.strictEqual(p.n, 4);
  assert.strictEqual(p.n_ok, 1, 'ok:null 不得计成功（旧实现 !==false 会得 3）');
  assert.strictEqual(p.n_samp, 2);
});

test('P0-3 全 null 小时：合并后 ok:null/loss:null，可用率为 null（不再显示 100%）', async () => {
  const id = db.createAgent({ name: 'avail-null' }).id;
  const h0 = rollup.hourStart(Date.now() - 3 * H);
  for (let i = 0; i < 3; i++) {
    metric(id, h0 + i * MIN, { t: { ms: null, ok: null, loss: null } });
  }
  rollup.foldHour(h0);
  const row = db.db.prepare('SELECT probes_hour FROM metrics_hour WHERE agent_id=? AND hour_ts=?').get(id, h0);
  const ph = JSON.parse(row.probes_hour).t;
  assert.strictEqual(ph.n_ok, 0, '全 null 小时 n_ok 必须为 0');
  assert.strictEqual(ph.n_samp, 0);

  const q = await request(app).get(`/api/public/agents/${id}/probes?range=24h&availability=1`);
  assert.strictEqual(q.status, 200);
  const point = q.body.series.t[0];
  assert.strictEqual(point.ok, null, '合并后必须 ok:null');
  assert.strictEqual(point.loss, null, '合并后必须 loss:null');
  assert.strictEqual(point.n_samp, 0);
  assert.strictEqual(point.ok_rate, null);
  assert.ok(!q.body.availability.t, '无采样小时不得产生可用率统计');
});

test('P0-3 混合桶：1 成功/100 失败 → ok_rate≈1%、可用率 1%（修前冒充 100%）', async () => {
  const id = db.createAgent({ name: 'avail-mix' }).id;
  const h0 = rollup.hourStart(Date.now() - 3 * H);
  metric(id, h0 + MIN, { t: { ms: 10, ok: true, loss: 0 } });
  for (let i = 0; i < 100; i++) {
    metric(id, h0 + 2 * MIN + i, { t: { ms: null, ok: false, loss: 100 } });
  }
  rollup.foldHour(h0);

  const q = await request(app).get(`/api/public/agents/${id}/probes?range=24h&availability=1`);
  assert.strictEqual(q.status, 200);
  const point = q.body.series.t[0];
  assert.strictEqual(point.ok, true, 'ok 保留兼容语义（任一成功即可达）');
  assert.strictEqual(point.n_ok, 1);
  assert.strictEqual(point.n_samp, 101);
  assert.ok(Math.abs(point.ok_rate - 0.01) < 0.001, `ok_rate≈1%，实际 ${point.ok_rate}`);

  const av = q.body.availability.t;
  assert.strictEqual(av.samples, 101);
  assert.strictEqual(av.up_pct, 1, `混合桶可用率应为 1%（修前按桶等权得 100），实际 ${av.up_pct}`);
});

test('P0-3 可用率加权：(0/1) 与 (100/100) 两桶 ≈99.0%（容差 0.5%）', async () => {
  const id = db.createAgent({ name: 'avail-weight' }).id;
  const h0 = rollup.hourStart(Date.now() - 4 * H);
  metric(id, h0 + MIN, { t: { ms: null, ok: false, loss: 100 } }); // 桶 A：0/1
  rollup.foldHour(h0);
  for (let i = 0; i < 100; i++) {
    metric(id, h0 + H + (i % 50) * MIN + i, { t: { ms: 5, ok: true, loss: 0 } }); // 桶 B：100/100
  }
  rollup.foldHour(h0 + H);

  const q = await request(app).get(`/api/public/agents/${id}/probes?range=24h&availability=1`);
  assert.strictEqual(q.status, 200);
  const av = q.body.availability.t;
  assert.strictEqual(av.samples, 101);
  assert.strictEqual(av.down_samples, 1);
  assert.ok(Math.abs(av.up_pct - 99.0) <= 0.5, `加权可用率应 ≈99.0%，实际 ${av.up_pct}`);
});
