'use strict';
// S1.5 手工修正月流量：PATCH /api/agents/:id/traffic
// 核心不变量（对齐 monitor set_traffic）：修正值必须打「当前周期」戳，
// 否则下一轮上报按旧周期把修正清零。
process.env.PORT = '0';
process.env.DB_PATH = '/tmp/diting-traffic-correct-test.db';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'traffic-correct-admin-token-0123456789';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');

const ADMIN = { 'X-Forwarded-Proto': 'https', 'X-Admin-Token': process.env.ADMIN_TOKEN };

after(async () => {
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

function mkAgent(name, monthRotate) {
  const a = db.createAgent({ name });
  db.updateAgent(a.id, Object.assign({}, db.getAgent(a.id), { name, month_rotate: monthRotate }));
  return a;
}

const report = (a, rx, tx, epoch = 'aa/bb') =>
  request(app).post('/api/report').set('X-Agent-ID', a.id).set('Authorization', 'Bearer ' + a.token)
    .send({ cpu: 1, mem_total: 1000, disk_total: 1000, uptime: 100, month_rotate: 1, net_rx: rx, net_tx: tx, net_epoch: epoch });

const state = (id) => db.db.prepare('select used_rx,used_tx,cycle_key,cycle_start from traffic_state where agent_id=?').get(id);

test('S1.5 修正打当前周期戳：下一轮上报不清零、在修正值上累加 delta', async () => {
  const a = mkAgent('tc-1', 1);
  await report(a, 1000, 500);           // 首报只对齐基线
  db.flushTraffic();

  const r = await request(app).patch(`/api/agents/${a.id}/traffic`).set(ADMIN).send({ rx: 777, tx: 888 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.used_rx, 777);
  assert.strictEqual(r.body.used_tx, 888);
  // 周期戳 = 当前周期（month_rotate=1 → 每月 1 号）
  assert.strictEqual(r.body.cycle_key, db.db.prepare("select strftime('%Y-%m-01','now') k").get().k);

  db.flushTraffic();
  assert.deepStrictEqual(
    { rx: state(a.id).used_rx, tx: state(a.id).used_tx },
    { rx: 777, tx: 888 },
    '修正值必须落盘',
  );

  // 下一轮上报：delta 应叠加在修正值上（若周期戳没打对，这里会被清零）
  await report(a, 1300, 700);
  db.flushTraffic();
  assert.deepStrictEqual(
    { rx: state(a.id).used_rx, tx: state(a.id).used_tx },
    { rx: 1077, tx: 1088 },
    '修正后应继续累加 delta（777+300 / 888+200）',
  );
});

test('S1.5 只修提供的字段；面板（latest metric）同步可见', async () => {
  const a = mkAgent('tc-2', 1);
  await report(a, 1000, 500);
  db.flushTraffic();

  const r1 = await request(app).patch(`/api/agents/${a.id}/traffic`).set(ADMIN).send({ rx: 1000 });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.body.used_rx, 1000);
  assert.strictEqual(r1.body.used_tx, 0, '未提供的字段不变（首报后 used_tx=0）');

  const r2 = await request(app).patch(`/api/agents/${a.id}/traffic`).set(ADMIN).send({ tx: 4242 });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.used_rx, 1000);
  assert.strictEqual(r2.body.used_tx, 4242);

  const m = db.db.prepare('select net_rx_month,net_tx_month from metrics where agent_id=? order by ts desc limit 1').get(a.id);
  assert.deepStrictEqual(m, { net_rx_month: 1000, net_tx_month: 4242 }, '最新一条明细必须同步，面板立即可见');
});

test('S1.5 rotate=0（绝对累计）：周期戳为 cumulative', async () => {
  const a = mkAgent('tc-3', 0);
  await report(a, 5000, 6000);
  db.flushTraffic();
  const r = await request(app).patch(`/api/agents/${a.id}/traffic`).set(ADMIN).send({ rx: 1, tx: 2 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.cycle_key, 'cumulative');
  assert.strictEqual(r.body.cycle_start, null);
  // 绝对累计口径下下一轮上报会用计数器覆盖修正值（文档化行为）
  await report(a, 5100, 6100);
  db.flushTraffic();
  assert.deepStrictEqual(
    { rx: state(a.id).used_rx, tx: state(a.id).used_tx },
    { rx: 5100, tx: 6100 },
    'rotate=0 的计数器即事实源，修正被覆盖是预期',
  );
});

test('S1.5 校验：空体 / 负值 / 非数字 / 超安全整数 / 未知节点', async () => {
  const a = mkAgent('tc-4', 1);
  await report(a, 100, 100);

  const empty = await request(app).patch(`/api/agents/${a.id}/traffic`).set(ADMIN).send({});
  assert.strictEqual(empty.status, 400);
  assert.strictEqual(empty.body.error, 'rx_or_tx_required');

  const neg = await request(app).patch(`/api/agents/${a.id}/traffic`).set(ADMIN).send({ rx: -1 });
  assert.strictEqual(neg.status, 400);
  assert.strictEqual(neg.body.error, 'invalid_traffic_value');

  const nan = await request(app).patch(`/api/agents/${a.id}/traffic`).set(ADMIN).send({ tx: 'abc' });
  assert.strictEqual(nan.status, 400);

  const huge = await request(app).patch(`/api/agents/${a.id}/traffic`).set(ADMIN).send({ rx: Number.MAX_SAFE_INTEGER + 10 });
  assert.strictEqual(huge.status, 400);

  const nf = await request(app).patch('/api/agents/agt_does_not_exist/traffic').set(ADMIN).send({ rx: 1 });
  assert.strictEqual(nf.status, 404);

  // 修正必须落审计（高危写操作）
  await request(app).patch(`/api/agents/${a.id}/traffic`).set(ADMIN).send({ rx: 10, tx: 20 });
  const audit = db.db.prepare("select detail from audit_logs where action='traffic_correct' order by id desc limit 1").get();
  assert.ok(audit && audit.detail.includes(a.id), '应写审计日志');
  assert.ok(audit.detail.includes('rx=10') && audit.detail.includes('tx=20'));
});
