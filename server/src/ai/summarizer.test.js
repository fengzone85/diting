'use strict';
// summarizeAgent 的负载归一化单测（§9 T18）
//
// 回归背景：load.avg1 没有分母时，1 核机的 0.18 与 8 核机的 0.18 会被模型当成同一件事；
// 老 agent 不上报核数（cores=0）时**必须**让字段缺席并显式标记 cores_unknown，
// 而不是把 0/1 当分母（0 会导致 Infinity，1 会把负载放大到离谱）。
//
// summarizeAgent 本身零 DB 依赖（只用 agent + rows + opts），但 require 本模块会连带
// require ../db，故必须先设置 DB_PATH=':memory:' 再 require。
//
// 运行：cd server && /usr/bin/node --test src/ai/summarizer.test.js

process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const { test } = require('node:test');
const assert = require('node:assert');
const { summarizeAgent } = require('./summarizer');

function row(load1, extra) {
  return Object.assign({ cpu: 10, mem_pct: 50, disk_pct: 60, net_rx_rate: 1000, load1, swap_pct: 0 }, extra || {});
}

const AGENT = { id: 'agt_t', name: 't', last_seen: Date.now(), cores: 4 };

test('有核数：给出 cpu.cores 与 load.avg1_per_core（保留 2 位）', () => {
  const s = summarizeAgent(AGENT, [row(2), row(4)], { intervalSec: 20, offlineSec: 60, cpuAlert: 90, memAlert: 90, silentDays: 0 });
  assert.strictEqual(s.cpu.cores, 4);
  assert.strictEqual(s.load.avg1, 3);
  assert.strictEqual(s.load.avg1_per_core, 0.75, '3 / 4 核');
  assert.ok(!Object.prototype.hasOwnProperty.call(s.load, 'cores_unknown'), '有核数时不应出现 cores_unknown');
});

test('无核数（老 agent）：cpu.cores=null、load 缺席分母并标记 cores_unknown', () => {
  const s = summarizeAgent(Object.assign({}, AGENT, { cores: 0 }), [row(0.18)], { intervalSec: 20, offlineSec: 60, cpuAlert: 90, memAlert: 90, silentDays: 0 });
  assert.strictEqual(s.cpu.cores, null);
  assert.strictEqual(s.load.avg1, 0.18, '原始 load1 仍保留（供排查），只是没有分母');
  assert.ok(!Object.prototype.hasOwnProperty.call(s.load, 'avg1_per_core'), '不得用 0/1 冒充分母');
  assert.strictEqual(s.load.cores_unknown, true);
});

test('核数字段缺失（undefined）与非法值同样按未知处理', () => {
  for (const cores of [undefined, null, -1, 'x', NaN]) {
    const s = summarizeAgent(Object.assign({}, AGENT, { cores }), [row(1)], { intervalSec: 20, offlineSec: 60, cpuAlert: 90, memAlert: 90, silentDays: 0 });
    assert.strictEqual(s.cpu.cores, null, `cores=${String(cores)} 应视为未知`);
    assert.strictEqual(s.load.cores_unknown, true);
  }
});

test('负载样本为空时：avg1=null 且 avg1_per_core 也为 null（有核数）', () => {
  const s = summarizeAgent(AGENT, [], { intervalSec: 20, offlineSec: 60, cpuAlert: 90, memAlert: 90, silentDays: 0 });
  assert.strictEqual(s.load.avg1, null);
  assert.strictEqual(s.load.avg1_per_core, null);
  assert.strictEqual(s.cpu.cores, 4);
});
