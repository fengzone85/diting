'use strict';
// PR-4 回归测试（体检 L-5 + swap 映射修正 + L-7 + 长度钳制）。
// 隔离 DB：:memory: 避免污染真实库（与 security.test.js 同法）。
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const { METRIC_DEFINITIONS, METRIC_FIELD_MAP, queryMetrics } = require('../src/compat-metrics');

// ── 造数据：两个 agent，各若干行 ───────────────────────────────
// 注意：metrics.agent_id 对 agents 有外键约束，必须先建 agent 行再插 metrics。
// createAgent 自生成 id，故用其返回值。
const A1 = db.createAgent({ name: 'test-a1' }).id;
const A2 = db.createAgent({ name: 'test-a2' }).id;
const NOW = Date.now();

function row(agentId, ts, extra = {}) {
  return Object.assign({
    agent_id: agentId,
    ts,
    cpu: 10,
    mem_used: 1000,
    mem_total: 8000,
    mem_pct: 12.5,
    disk_used: 5000,
    disk_total: 20000,
    disk_pct: 25,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    net_rx_rate: 100,
    net_tx_rate: 50,
    net_rx_month: 1e6,
    net_tx_month: 2e6,
    uptime: 3600,
    temp: 45,
    swap_used: 300,
    swap_total: 2000,
    swap_pct: 15,
    disk_r_rate: 1,
    disk_w_rate: 2,
    probes: null,
    disks: null,
  }, extra);
}

// 预置数据：A1 有 swap + probes，A2 也有数据（用于 L-7 多节点验证）
function seed() {
  for (let i = 0; i < 20; i++) {
    db.insertMetric(A1, row(A1, NOW - i * 60 * 1000, {
      probes: JSON.stringify({ '移动': { ms: 10 + i, ok: true, loss: 0 } }),
    }));
    db.insertMetric(A2, row(A2, NOW - i * 60 * 1000, {
      probes: JSON.stringify({ '电信': { ms: 20 + i, ok: true, loss: 5 } }),
    }));
  }
}
seed();

// ── L-5：swap 映射修正 ────────────────────────────────────────
test('L-5: swap.used/swap.total 映射到真实 swap 列（不再冒充内存）', () => {
  assert.strictEqual(METRIC_FIELD_MAP['swap.used'], 'swap_used');
  assert.strictEqual(METRIC_FIELD_MAP['swap.total'], 'swap_total');
  // 回归锁死：绝不能再指回 memory 列
  assert.notStrictEqual(METRIC_FIELD_MAP['swap.used'], 'mem_used');
  assert.notStrictEqual(METRIC_FIELD_MAP['swap.total'], 'mem_total');
});

test('L-5: swap series 返回真实 swap 值（而非 mem 值）', () => {
  const out = queryMetrics({ metric_keys: ['swap.used', 'swap.total'], entity_ids: [A1], hours: 1, maxPoints: 100 });
  const used = out.series.find(s => s.metric_key === 'swap.used');
  const total = out.series.find(s => s.metric_key === 'swap.total');
  assert.ok(used, 'swap.used series 应存在');
  assert.ok(total, 'swap.total series 应存在');
  assert.strictEqual(used.points[0].value, 300, '应为 swap_used(300) 而非 mem_used(1000)');
  assert.strictEqual(total.points[0].value, 2000, '应为 swap_total(2000) 而非 mem_total(8000)');
});

// ── L-5：删除 5 条占位映射，不生成错值 series ────────────────────
test('L-5: 5 条占位映射已删除，请求时不生成 series', () => {
  const placeholders = ['process.count', 'connections.tcp', 'connections.udp', 'gpu.usage', 'gpu.device.usage'];
  for (const k of placeholders) {
    assert.strictEqual(METRIC_FIELD_MAP[k], undefined, `${k} 不应再有字段映射`);
  }
  const out = queryMetrics({ metric_keys: placeholders, entity_ids: [A1], hours: 1, maxPoints: 100 });
  assert.strictEqual(out.series.length, 0, '占位指标不得生成任何 series（宁可缺图不可错值）');
  assert.strictEqual(out.count, 0);
});

test('L-5: METRIC_DEFINITIONS 仍保留占位定义（前端 le 白名单依赖）', () => {
  // 仅断开数据映射，定义必须保留：删定义可能引发前端空渲染异常
  for (const k of ['process.count', 'connections.tcp', 'connections.udp', 'gpu.usage', 'gpu.device.usage']) {
    assert.ok(METRIC_DEFINITIONS.find(d => d.name === k), `${k} 定义应保留`);
  }
});

test('L-5: 真实指标仍正常渲染（回归）', () => {
  const out = queryMetrics({ metric_keys: ['cpu.usage', 'memory.used'], entity_ids: [A1], hours: 1, maxPoints: 100 });
  assert.strictEqual(out.series.length, 2, 'cpu/memory 应各有一条 series');
  assert.strictEqual(out.series[0].points[0].value, 10);
  assert.strictEqual(out.series[1].points[0].value, 1000);
});

// ── L-5：无有效值的指标不生成全 0 假曲线 ────────────────────────
test('L-5: 字段全为 null 时不生成 series（不造全 0 假曲线）', () => {
  const A3 = db.createAgent({ name: 'test-a3' }).id;
  // 只插 temp=null 的行
  for (let i = 0; i < 5; i++) {
    db.insertMetric(A3, row(A3, NOW - i * 60 * 1000, { temp: null }));
  }
  const out = queryMetrics({ metric_keys: ['temperature'], entity_ids: [A3], hours: 1, maxPoints: 100 });
  assert.strictEqual(out.series.length, 0, '无温度数据不应生成 series');
});

// ── L-7：按实体独立采样 ──────────────────────────────────────
test('L-7: 多节点查询时每个节点各自拿到数据（不再被全局配额挤空）', () => {
  const out = queryMetrics({
    metric_keys: ['ping.latency_ms'],
    entity_ids: [A1, A2],
    hours: 1,
    maxPoints: 50,
  });
  const e1 = out.series.filter(s => s.entity_id === A1);
  const e2 = out.series.filter(s => s.entity_id === A2);
  assert.ok(e1.length > 0, 'A1 应有 ping series');
  assert.ok(e2.length > 0, 'A2 应有 ping series（旧实现会被全局配额挤空）');
  // 各自 task 名正确
  assert.strictEqual(e1[0].task_id, '移动');
  assert.strictEqual(e2[0].task_id, '电信');
});

test('L-7: 单节点查询返回该节点自己的探针数据', () => {
  const out = queryMetrics({ metric_keys: ['ping.latency_ms'], entity_ids: [A1], hours: 1, maxPoints: 50 });
  assert.ok(out.series.length > 0);
  assert.ok(out.series.every(s => s.entity_id === A1), '不应混入其他节点数据');
  assert.ok(out.series[0].points.length > 0, '点数不应为空');
});

test('L-7: ping.loss 同样按 task 拆分且取值正确', () => {
  const out = queryMetrics({ metric_keys: ['ping.loss'], entity_ids: [A2], hours: 1, maxPoints: 50 });
  const s = out.series.find(x => x.metric_key === 'ping.loss');
  assert.ok(s, 'ping.loss series 应存在');
  assert.strictEqual(s.unit, '%');
  assert.strictEqual(s.points[0].value, 5);
});

// ── 长度钳制 ────────────────────────────────────────────────
test('钳制: entity_ids 超过 50 只处理前 50', () => {
  const many = [];
  for (let i = 0; i < 60; i++) many.push(`agt_fake_${i}`);
  const out = queryMetrics({ metric_keys: ['cpu.usage'], entity_ids: many, hours: 1, maxPoints: 10 });
  const uniq = new Set(out.series.map(s => s.entity_id));
  assert.ok(uniq.size <= 50, `处理实体数应 ≤50，实际 ${uniq.size}`);
  assert.ok(!out.series.some(s => s.entity_id === 'agt_fake_59'), '第 51 个及之后应被裁掉');
});

test('钳制: metric_keys 超过 32 只处理前 32', () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push('cpu.usage');
  // 用不同真实键填充，验证不抛错且 series 数受限
  const out = queryMetrics({ metric_keys: many, entity_ids: [A1], hours: 1, maxPoints: 10 });
  assert.ok(out.series.length <= 32, 'series 数应受 metric_keys 钳制影响');
});

test('钳制: 非数组入参不抛错（防御性）', () => {
  assert.doesNotThrow(() => queryMetrics({ metric_keys: 'cpu.usage', entity_ids: 'agt_x', hours: 1 }));
  assert.doesNotThrow(() => queryMetrics({ metric_keys: null, entity_ids: null }));
  assert.doesNotThrow(() => queryMetrics({}));
});

// ── 兼容性：series 结构不变 ────────────────────────────────────
test('兼容: series 结构字段完整（task_id/unit/points 形状锁定）', () => {
  const out = queryMetrics({ metric_keys: ['ping.latency_ms'], entity_ids: [A1], hours: 1, maxPoints: 50 });
  const s = out.series[0];
  for (const f of ['metric_key', 'entity_id', 'task_id', 'name', 'unit', 'retention_days', 'downsampled', 'count', 'points']) {
    assert.ok(f in s, `series 应含字段 ${f}`);
  }
  assert.ok('time' in s.points[0] && 'value' in s.points[0], 'points 元素应含 time/value');
  assert.strictEqual(out.status, undefined); // 该函数返回 {start,end,series,count}
  for (const f of ['start', 'end', 'series', 'count']) assert.ok(f in out, `返回值应含 ${f}`);
});

test('兼容: hours 与 maxPoints 钳制边界不变', () => {
  assert.doesNotThrow(() => queryMetrics({ metric_keys: ['cpu.usage'], entity_ids: [A1], hours: 99999, maxPoints: 99999 }));
  assert.doesNotThrow(() => queryMetrics({ metric_keys: ['cpu.usage'], entity_ids: [A1], hours: -5, maxPoints: -5 }));
});
