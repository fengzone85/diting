'use strict';
// ============================================================
// PR1 回归：兼容层与标准 API 字段映射修正
// 方案：plans/2026-10-26-komari-compat-fields.md §3.3
//
// 断言要点：
//   1. cpu_cores 取 agents.cores 真实值（未上报为 0）
//   2. kernel_version 恒为 ''（回归锁死：绝不能再等于 hostname）
//   3. 实时态 process / 扁平态 temp、process 取 metrics 真实值
//   4. 价格/周期/币种换算口径（diting ↔ Komari）
//   5. billing_cycle = 0（白嫖/一次性）不被 || 30 吞掉
//   6. CAPABILITY.cpu_cores = true
//   7. 标准 API：kernel = null，hostname 独立字段，cpu_cores 有值
//   8. chartDashboardTemplate.cards 去掉无数据源的三张图
// ============================================================
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const db = require('../src/db');
const compat = require('../src/compat');
const v1 = require('../src/v1');

const NOW = Date.now();

function mkAgent(fields) {
  const { id } = db.createAgent(fields);
  return db.getAgent(id);
}

// 主节点：有核数、有主机名、有一条完整指标
const A = (() => {
  const a = mkAgent({ name: 'compat-a', price: 0, billing_cycle: 30, currency: '¥' });
  db.touchAgent(a.id, 'Debian 12', 'node-alpha', '1.1.5');
  db.setAgentCores(a.id, 4);
  db.insertMetric(a.id, {
    ts: NOW,
    cpu: 12,
    temp: 47,
    process_count: 231,
    mem_total: 8192,
    mem_used: 1024,
    swap_total: 2048,
    swap_used: 0,
    disk_total: 100000,
    disk_used: 20000,
    net_rx_rate: 10,
    net_tx_rate: 20
  });
  return db.getAgent(a.id);
})();

test('cpu_cores 取 agents.cores 真实值，未上报为 0', () => {
  assert.strictEqual(compat.toNode(A, true).cpu_cores, 4);
  const noCores = mkAgent({ name: 'compat-no-cores' });
  assert.strictEqual(compat.toNode(noCores, true).cpu_cores, 0);
});

test('kernel_version 恒为空串，绝不等于 hostname（回归锁死）', () => {
  const a = db.getAgent(A.id);
  assert.strictEqual(a.hostname, 'node-alpha');
  assert.strictEqual(compat.toNode(a, true).kernel_version, '');
});

test('实时态 process 与扁平态 temp/process 取真实采集值', () => {
  const m = db.getLatestMetric(A.id);
  assert.strictEqual(compat.toRealtime(m).process, 231);
  const st = compat.getNodesLatestStatus();
  assert.strictEqual(st[A.id].temp, 47);
  assert.strictEqual(st[A.id].process, 231);
});

test('价格换算：未设置 → -1、白嫖 → 0、正常原值、业务字段关闭 → -1', () => {
  const mk = (price) => mkAgent({ name: `compat-price-${price}-${Math.random()}`, price });
  assert.strictEqual(compat.toNode(mk(0), true).price, -1, 'diting 0 = 未设置 → Komari -1');
  assert.strictEqual(compat.toNode(mk(-1), true).price, 0, 'diting -1 = 白嫖 → Komari 0');
  assert.strictEqual(compat.toNode(mk(100), true).price, 100);
  assert.strictEqual(compat.toNode(mk(100), false).price, -1, '业务字段关闭 → 未设置');
});

test('billing_cycle = 0 原样保留，币种用真实值；关闭业务字段时回退约定值', () => {
  const a = mkAgent({ name: 'compat-free', price: -1, billing_cycle: 0, currency: '¥' });
  assert.strictEqual(compat.toNode(a, true).billing_cycle, 0, '0 = 白嫖/一次性，不能被 || 30 吞掉');
  assert.strictEqual(compat.toNode(a, true).currency, '¥');
  assert.strictEqual(compat.toNode(a, false).billing_cycle, 30);
  assert.strictEqual(compat.toNode(a, false).currency, '$');
  // 未设置/空值仍回退 30
  const unset = mkAgent({ name: 'compat-cycle-unset' });
  assert.strictEqual(compat.toNode(unset, true).billing_cycle, 30);
});

test('CAPABILITY 声明 cpu_cores 能力为 true', () => {
  assert.strictEqual(v1.CAPABILITY.cpu_cores, true);
});

test('标准 API：kernel 为 null，hostname 独立成字段，cpu_cores 有值', () => {
  const n = v1.toNode(db.getAgent(A.id), true);
  assert.strictEqual(n.kernel, null, '内核版本不采集，绝不用 hostname 冒充');
  assert.strictEqual(n.hostname, 'node-alpha');
  assert.strictEqual(n.cpu_cores, 4);
  // PR2 预留形状：PR1 恒 null
  assert.strictEqual(n.cpu_name, null);
  assert.strictEqual(n.arch, null);
  assert.strictEqual(n.virtualization, null);
});

test('GET /api/public 的 cards 不含 gpu/gpuMemory/connections，保留 process/temperature', async () => {
  const app = express();
  app.use('/api', compat.router);
  const res = await request(app).get('/api/public').expect(200);
  const cards = res.body.data.chartDashboardTemplate.cards;
  for (const k of ['gpu', 'gpuMemory', 'connections']) {
    assert.ok(!cards.includes(k), `cards 不应再含 ${k}`);
  }
  for (const k of ['process', 'temperature']) {
    assert.ok(cards.includes(k), `cards 应保留 ${k}`);
  }
});

test('GET /api/v1/nodes 出口字段与 toNode 一致', async () => {
  const app = express();
  app.use('/api/v1', v1.router);
  const res = await request(app).get('/api/v1/nodes').expect(200);
  const n = res.body.data.find((x) => x.uuid === A.id);
  assert.ok(n, '主节点应出现在列表里');
  assert.strictEqual(n.kernel, null);
  assert.strictEqual(n.hostname, 'node-alpha');
  assert.strictEqual(n.cpu_cores, 4);
});
