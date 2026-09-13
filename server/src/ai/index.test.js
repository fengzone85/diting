'use strict';
// 门面纯函数单测：窗口 clamp 与缓存键隔离（零网络、零模型调用）
//
// 回归背景（方案 §8 T16）：
//   1. 窗口只允许 24–720，非法/越界必须回落而不是透传（透传会让 summarizeOne 拉超大窗口）；
//   2. 缓存键必须含窗口——只按 agentId 缓存会让 7d 的结果命中 24h 的缓存（静默串味）。
//
// 运行：cd server && /usr/bin/node --test src/ai/index.test.js

// 必须在 require 之前设置：db.js 在 require 链中就会打开/建库（:memory: 保证零落盘）
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const { test } = require('node:test');
const assert = require('node:assert');
const ai = require('./index');

test('clampPeriodHours：合法值原样、越界夹紧、非法值回落默认 24', () => {
  assert.strictEqual(ai.clampPeriodHours(24), 24);
  assert.strictEqual(ai.clampPeriodHours(168), 168);
  assert.strictEqual(ai.clampPeriodHours(720), 720);

  assert.strictEqual(ai.clampPeriodHours(1), 24, '小于下限应夹到 24');
  assert.strictEqual(ai.clampPeriodHours(0), 24);
  assert.strictEqual(ai.clampPeriodHours(-5), 24);
  assert.strictEqual(ai.clampPeriodHours(99999), 720, '大于上限应夹到 720');

  assert.strictEqual(ai.clampPeriodHours('abc'), 24, '非数字回落默认');
  assert.strictEqual(ai.clampPeriodHours(undefined), 24);
  assert.strictEqual(ai.clampPeriodHours(null), 24);
  assert.strictEqual(ai.clampPeriodHours(NaN), 24);
  assert.strictEqual(ai.clampPeriodHours(Infinity), 24, 'Infinity 视为非法，回落默认');

  assert.strictEqual(ai.clampPeriodHours('168'), 168, '数字字符串应可用');
  assert.strictEqual(ai.clampPeriodHours(167.6), 168, '应四舍五入到整点窗口');
});

test('nodeCacheKey：窗口进入缓存键，同节点不同窗口不互撞', () => {
  assert.strictEqual(ai.nodeCacheKey('agt_x', 24), 'agt_x|24');
  assert.strictEqual(ai.nodeCacheKey('agt_x', 168), 'agt_x|168');
  assert.notStrictEqual(ai.nodeCacheKey('agt_x', 24), ai.nodeCacheKey('agt_x', 168));
  assert.notStrictEqual(ai.nodeCacheKey('agt_x', 24), ai.nodeCacheKey('agt_y', 24));
});
