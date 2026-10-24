'use strict';
// S1：流量记账三段式（epoch/重启补账/接口集变化/首报守卫）回归。
// 纯函数测试直接操纵 traffic.accumulate 的状态对象，不依赖真实时间。
process.env.DB_PATH = '/tmp/diting-traffic-epoch-test.db';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const db = require('../src/db');
const traffic = require('../src/traffic');
const { validateReport } = require('../src/validate');

after(() => {
  db.flushTraffic();
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

const AGENT = { month_rotate: 15 }; // 每月 15 日重置
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0); // 2026-10-24 12:00 UTC
const MIN = 60 * 1000;

const rep = (net_rx, net_tx, epoch, uptime) => ({
  net_rx, net_tx, net_epoch: epoch, uptime, month_rotate: 15,
});

test('S1 validate：net_epoch 恒返回字符串，字符集外归空，超长截断为空', () => {
  assert.strictEqual(validateReport({}).net_epoch, '');
  assert.strictEqual(validateReport({ net_epoch: 'abc-def/AB12_9@f' }).net_epoch, 'abc-def/AB12_9@f');
  assert.strictEqual(validateReport({ net_epoch: 'ab/{guid}' }).net_epoch, '', '花括号不得放行');
  assert.strictEqual(validateReport({ net_epoch: 'a'.repeat(81) }).net_epoch, '');
  assert.strictEqual(validateReport({ net_epoch: 12345 }).net_epoch, '', '非字符串归空');
});

test('S1 epoch 不变：正常累加 delta；接口集变化只对齐基线；之后继续累加', () => {
  const s = traffic.emptyState('a1');
  traffic.accumulate(s, AGENT, rep(1000, 500, 'a1b2c3d4/aaaa', 100), T0);
  assert.strictEqual(s.used_rx, 0, '首报只对齐基线');
  assert.strictEqual(s.epoch, 'a1b2c3d4/aaaa', 'epoch 必须落进状态');

  traffic.accumulate(s, AGENT, rep(1600, 800, 'a1b2c3d4/aaaa', 160), T0 + MIN);
  assert.deepStrictEqual({ rx: s.used_rx, tx: s.used_tx }, { rx: 600, tx: 300 });

  // 接口集变化（同一次启动，digest 变了）：不累加、不清零
  traffic.accumulate(s, AGENT, rep(5000, 4000, 'a1b2c3d4/bbbb', 220), T0 + 2 * MIN);
  assert.deepStrictEqual({ rx: s.used_rx, tx: s.used_tx }, { rx: 600, tx: 300 }, '接口集变化不得把新接口的生命周期计数计入');
  assert.strictEqual(s.last_rx, 5000, '基线必须对齐到新值');

  traffic.accumulate(s, AGENT, rep(5100, 4100, 'a1b2c3d4/bbbb', 280), T0 + 3 * MIN);
  assert.deepStrictEqual({ rx: s.used_rx, tx: s.used_tx }, { rx: 700, tx: 400 });
});

test('S1 重启补账：boot 段变化且 booted 晚于上次上报 → 整段 since-boot 计入', () => {
  const s = traffic.emptyState('a2');
  traffic.accumulate(s, AGENT, rep(1000, 500, 'a1b2c3d4/aaaa', 100), T0);
  traffic.accumulate(s, AGENT, rep(1200, 700, 'a1b2c3d4/aaaa', 160), T0 + MIN);
  assert.strictEqual(s.used_rx, 200);

  // 10 分钟后才发现：计数器已归零（base=250），uptime=100s → booted = T+10min-100s > last_ts
  const t1 = T0 + 11 * MIN;
  traffic.accumulate(s, AGENT, rep(250, 120, 'd5e6f708/cccc', 100), t1);
  assert.deepStrictEqual({ rx: s.used_rx, tx: s.used_tx }, { rx: 450, tx: 320 }, '离线期重启应补账 since-boot');
});

test('S1 重启但 booted 早于上次上报（观测延迟）→ 只对齐基线，不补账', () => {
  const s = traffic.emptyState('a3');
  traffic.accumulate(s, AGENT, rep(1000, 500, 'a1b2c3d4/aaaa', 100), T0);
  // uptime=3600 → booted = T0+1min-3600s，明显早于 last_ts
  traffic.accumulate(s, AGENT, rep(99999, 88888, 'd5e6f708/dddd', 3600), T0 + MIN);
  assert.deepStrictEqual({ rx: s.used_rx, tx: s.used_tx }, { rx: 0, tx: 0 });
  assert.strictEqual(s.last_rx, 99999);
});

test('S1 rotate=0（绝对累计）：重启也不叠加补账', () => {
  const s = traffic.emptyState('a4');
  const agent = { month_rotate: 0 };
  const r0 = (rx, tx, epoch, up) => ({ net_rx: rx, net_tx: tx, net_epoch: epoch, uptime: up, month_rotate: 0 });
  traffic.accumulate(s, agent, r0(1000, 500, 'a1b2c3d4/aaaa', 100), T0);
  traffic.accumulate(s, agent, r0(1200, 700, 'a1b2c3d4/aaaa', 160), T0 + MIN);
  assert.deepStrictEqual({ rx: s.used_rx, tx: s.used_tx }, { rx: 1200, tx: 700 });
  traffic.accumulate(s, agent, r0(300, 100, 'd5e6f708/cccc', 60), T0 + 11 * MIN);
  assert.deepStrictEqual({ rx: s.used_rx, tx: s.used_tx }, { rx: 300, tx: 100 }, '绝对口径只跟随绝对值');
  assert.strictEqual(s.cycle_key, 'cumulative', '周期簿记仍写 cumulative');
});

test('S1 老 agent（无 epoch）：首报只对齐，第二报起正常累加', () => {
  const s = traffic.emptyState('a5');
  const old = (rx, tx) => ({ net_rx: rx, net_tx: tx, month_rotate: 15 });
  traffic.accumulate(s, AGENT, old(1000, 500), T0);
  assert.strictEqual(s.used_rx, 0, '首报不得把整段 since-boot 计入');
  traffic.accumulate(s, AGENT, old(1600, 800), T0 + MIN);
  assert.deepStrictEqual({ rx: s.used_rx, tx: s.used_tx }, { rx: 600, tx: 300 }, '老 agent 后续必须正常累加');
  assert.strictEqual(s.epoch, '');
});

test('S1 uptime 缺失/非法：即使 boot 段变化也不补账', () => {
  const s = traffic.emptyState('a6');
  traffic.accumulate(s, AGENT, rep(1000, 500, 'a1b2c3d4/aaaa', 100), T0);
  traffic.accumulate(s, AGENT, rep(4000, 3000, 'd5e6f708/cccc', null), T0 + 11 * MIN);
  assert.deepStrictEqual({ rx: s.used_rx, tx: s.used_tx }, { rx: 0, tx: 0 });
});

test('S1 新周期首报记账：used = 本段 delta，而不是 0', () => {
  const s = traffic.emptyState('a7');
  traffic.accumulate(s, AGENT, rep(1000, 500, 'a1b2c3d4/aaaa', 100), T0 - 40 * 24 * 60 * MIN);
  // 手工把状态拨到上一周期末（等价于 9 月 15 日那轮）
  s.cycle_key = '2026-09-15';
  s.used_rx = 777;
  s.used_tx = 555;
  s.last_rx = 1000;
  s.last_tx = 500;
  s.last_ts = T0 - MIN;
  traffic.accumulate(s, AGENT, rep(1400, 700, 'a1b2c3d4/aaaa', 100), T0);
  assert.deepStrictEqual({ rx: s.used_rx, tx: s.used_tx }, { rx: 400, tx: 200 }, '新周期首报应记 delta');
});

test('S1 落盘：flush 后 traffic_state.epoch 不丢，重载后仍能识别接口集变化', () => {
  const a = db.createAgent({ name: 'traffic-epoch-persist' });
  db.updateAgent(a.id, { name: 'traffic-epoch-persist', month_rotate: 15 });
  const r1 = validateReport({ cpu: 1, mem_total: 1, net_rx: 1000, net_tx: 500, net_epoch: 'a1b2c3d4/aaaa', uptime: 100, month_rotate: 15 });
  db.accumulateTraffic(a.id, r1, T0);
  db.flushTraffic();
  const row = db.db.prepare('SELECT * FROM traffic_state WHERE agent_id=?').get(a.id);
  assert.strictEqual(row.epoch, 'a1b2c3d4/aaaa', 'flush 必须把 epoch 落盘');

  // 接口集变化（同一行状态重新参与计算）→ 只对齐基线
  const r2 = validateReport({ cpu: 1, mem_total: 1, net_rx: 9000, net_tx: 8000, net_epoch: 'a1b2c3d4/bbbb', uptime: 200, month_rotate: 15 });
  const out = db.accumulateTraffic(a.id, r2, T0 + 60 * MIN);
  assert.strictEqual(out.used_rx, 0, '接口集变化后不得把新接口计数计入');
});
