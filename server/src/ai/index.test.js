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
const db = require('../db');

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

test('nodeCacheTtlMs：默认与下限均为 30 分钟，可上调，非法值回落', () => {
  assert.strictEqual(ai.nodeCacheTtlMs({}), 30 * 60000);
  assert.strictEqual(ai.nodeCacheTtlMs({ node_cache_ttl_minutes: 60 }), 60 * 60000);
  assert.strictEqual(ai.nodeCacheTtlMs({ node_cache_ttl_minutes: 1440 }), 1440 * 60000);
  assert.strictEqual(ai.nodeCacheTtlMs({ node_cache_ttl_minutes: 5 }), 30 * 60000, '下限 30 分钟，成本护栏不允许更小');
  assert.strictEqual(ai.nodeCacheTtlMs({ node_cache_ttl_minutes: 0 }), 30 * 60000);
  assert.strictEqual(ai.nodeCacheTtlMs({ node_cache_ttl_minutes: 'abc' }), 30 * 60000);
  assert.strictEqual(ai.nodeCacheTtlMs(undefined), 30 * 60000);
});

test('单节点历史：落库 → 列表（倒序 + limit + 不含 report_json）', () => {
  db.insertAiNodeReport({ agent_id: 'agt_hist', period_hours: 24, risk_level: 'low', total_tokens: 10, created_at: Date.now() - 60000 });
  db.insertAiNodeReport({ agent_id: 'agt_hist', period_hours: 168, risk_level: 'high', total_tokens: 20, created_at: Date.now() });

  const list = db.listAiNodeReports('agt_hist', 10);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].period_hours, 168, '应按 created_at 倒序');
  assert.strictEqual(list[0].risk_level, 'high');
  assert.ok(!Object.prototype.hasOwnProperty.call(list[0], 'report_json'), '列表刻意不返回 report_json');

  assert.strictEqual(db.listAiNodeReports('agt_hist', 1).length, 1, 'limit 生效');
  assert.strictEqual(db.listAiNodeReports('agt_other', 10).length, 0, '按 agent 隔离');
});

test('单节点历史：随保留期清理', () => {
  db.insertAiNodeReport({ agent_id: 'agt_old', period_hours: 24, created_at: Date.now() - 40 * 86400000 });
  assert.strictEqual(db.listAiNodeReports('agt_old', 10).length, 1);
  const removed = db.pruneAiNodeReports(30);
  assert.ok(removed >= 1, '超过保留期的记录应被清理');
  assert.strictEqual(db.listAiNodeReports('agt_old', 10).length, 0);
});
