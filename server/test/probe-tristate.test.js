'use strict';
// S3 探测三态回归：正常 / 不可达 / 无采样（解析超时）。
// 无采样必须在「入库 → 接口 → 可用率 → AI 聚合」全链路保持 null，
// 不能被压成 100% 丢包或失败样本。
process.env.PORT = '0';
process.env.DB_PATH = '/tmp/diting-probe-tristate-test.db';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'probe-tristate-admin-token-0123456789';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const { validateReport } = require('../src/validate');
const { aggregateProbes } = require('../src/ai/stats');

after(async () => {
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

test('S3 validate：三态归一（无采样不压成 loss=100）', () => {
  const r = validateReport({
    probes: {
      nosample: { ms: null, ok: null, loss: null },
      down: { ms: null, ok: false, loss: 100 },
      nullLoss: { ms: null, ok: false, loss: null },
      slow: { ms: 12, ok: true, loss: null },
      legacyFail: { ms: null, ok: false },
      legacyOk: { ms: 8, ok: true },
    },
  });
  const p = JSON.parse(r.probes);
  assert.deepStrictEqual(p.nosample, { ms: null, ok: null, loss: null });
  assert.deepStrictEqual(p.down, { ms: null, ok: false, loss: 100 });
  assert.deepStrictEqual(p.nullLoss, { ms: null, ok: null, loss: null }, 'ms/loss 双 null 即无采样');
  assert.deepStrictEqual(p.slow, { ms: 12, ok: true, loss: null });
  assert.deepStrictEqual(p.legacyFail, { ms: null, ok: false, loss: 100 });
  assert.deepStrictEqual(p.legacyOk, { ms: 8, ok: true, loss: 0 });
});

test('S3 上报/接口：无采样入库为 null，可用率样本不计入', async () => {
  const a = db.createAgent({ name: 'tristate-node' });
  const payload = {
    hostname: 'h', os: 'linux', uptime: 100, cpu: 10, mem_total: 1000, mem_pct: 10,
    probes: {
      nosample: { ms: null, ok: null, loss: null },
      down: { ms: null, ok: false, loss: 100 },
      ok1: { ms: 8, ok: true, loss: 0 },
    },
  };
  const rep = await request(app).post('/api/report')
    .set('X-Agent-ID', a.id).set('Authorization', 'Bearer ' + a.token).send(payload);
  assert.strictEqual(rep.status, 200);

  const stored = JSON.parse(db.getLatestMetric(a.id).probes);
  assert.deepStrictEqual(stored.nosample, { ms: null, ok: null, loss: null }, '入库必须保留 null');

  const q = await request(app).get(`/api/public/agents/${a.id}/probes?range=24h&availability=1`);
  assert.strictEqual(q.status, 200);
  const point = q.body.series.nosample[0];
  assert.strictEqual(point.ms, null);
  assert.strictEqual(point.ok, null, '接口必须输出 ok:null 而不是 false');
  assert.strictEqual(point.loss, null, '接口必须输出 loss:null 而不是 100');

  const av = q.body.availability;
  assert.strictEqual(av.nosample, undefined, '无采样标签不应产生可用率统计');
  assert.strictEqual(av.down.samples, 1);
  assert.strictEqual(av.down.up_pct, 0);
  assert.strictEqual(av.ok1.samples, 1);
  assert.strictEqual(av.ok1.up_pct, 100);
});

test('S3 AI 聚合：无采样不计 samples、不计失败', () => {
  const rows = [{
    probes: JSON.stringify({
      nosample: { ms: null, ok: null, loss: null },
      down: { ms: null, ok: false, loss: 100 },
      ok1: { ms: 8, ok: true, loss: 0 },
    }),
  }];
  const out = aggregateProbes(rows, {});
  const by = Object.fromEntries(out.map((x) => [x.task, x]));
  assert.ok(!by.nosample, '无采样任务不应进入聚合结果');
  assert.strictEqual(by.down.samples, 1);
  assert.strictEqual(by.down.ok_rate, 0);
  assert.strictEqual(by.ok1.samples, 1);
  assert.strictEqual(by.ok1.ok_rate, 100);
});
