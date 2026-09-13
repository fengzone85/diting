'use strict';
// PR-3 回归测试（体检 L-3 审计清理接入 + L-4 审计 diff 粒度）。
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const { diffKeys } = require('../src/api');

const DAY = 86400000;

// ── L-3：pruneAudit 行为 ────────────────────────────────────
test('L-3: pruneAudit 只删超过保留期的条目', () => {
  const now = Date.now();
  // 旧条（100 天前）、边界条（89 天前）、新鲜条
  db.addAuditLog(now - 100 * DAY, 'admin', '1.1.1.1', 'old_action', 'd', '');
  db.addAuditLog(now - 89 * DAY, 'admin', '1.1.1.1', 'recent_action', 'd', '');
  db.addAuditLog(now - 1 * DAY, 'admin', '1.1.1.1', 'fresh_action', 'd', '');

  const before = db.countAudit();
  const removed = db.pruneAudit(90);
  const after = db.countAudit();

  assert.strictEqual(removed, 1, '只应删掉 100 天前那一条');
  assert.strictEqual(after, before - 1);
  // 剩下的记录里不应再有 old_action
  const all = db.getAuditLogs(1000, 0);
  assert.ok(!all.some(l => l.action === 'old_action'), '旧条应被删除');
  assert.ok(all.some(l => l.action === 'recent_action'), '89 天前应保留');
  assert.ok(all.some(l => l.action === 'fresh_action'), '新鲜条应保留');
});

test('L-3: pruneAudit 边界——恰好等于保留期当天不被删', () => {
  const now = Date.now();
  // cutoff = now - 90d；ts < cutoff 才删 → 恰好 90 天整条不应被删（用 +1s 规避毫秒竞态）
  db.addAuditLog(now - 90 * DAY + 1000, 'admin', 'x', 'exact_boundary', 'd', '');
  const removed = db.pruneAudit(90);
  const all = db.getAuditLogs(1000, 0);
  assert.ok(all.some(l => l.action === 'exact_boundary'), '边界当天应保留');
  // removed 可能为 0 或含前述测试残留，但不影响本条断言
  assert.ok(removed >= 0);
});

test('L-3: pruneAudit 返回删除条数（供 runPrune 日志使用）', () => {
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    db.addAuditLog(now - (200 + i) * DAY, 'admin', 'x', `bulk_${i}`, 'd', '');
  }
  const removed = db.pruneAudit(90);
  assert.ok(removed >= 3, `应至少删除 3 条，实际 ${removed}`);
  assert.strictEqual(typeof removed, 'number');
});

// ── L-4：diffKeys ─────────────────────────────────────────
test('L-4: diffKeys 只返回变更的字段名', () => {
  const before = { name: 'a', note: 'n1', grp: 'g' };
  const after = { name: 'b', note: 'n1', grp: 'g' };
  assert.strictEqual(diffKeys(before, after), 'name');
});

test('L-4: diffKeys 多字段变更按出现顺序拼接', () => {
  const before = { a: 1, b: 2, c: 3 };
  const after = { a: 9, b: 2, c: 8 };
  assert.strictEqual(diffKeys(before, after), 'a,c');
});

test('L-4: diffKeys 无变更返回空串', () => {
  assert.strictEqual(diffKeys({ a: 1 }, { a: 1 }), '');
  assert.strictEqual(diffKeys({}, {}), '');
  assert.strictEqual(diffKeys(null, null), '');
});

test('L-4: diffKeys 新增/删除字段也计入', () => {
  assert.strictEqual(diffKeys({ a: 1 }, { a: 1, b: 2 }), 'b', '新增字段应计入');
  assert.strictEqual(diffKeys({ a: 1, b: 2 }, { a: 1 }), 'b', '删除字段应计入');
});

test('L-4: diffKeys 敏感键打码为 k=*（不含原值）', () => {
  const out = diffKeys(
    { api_key: 'old', smtp_pass: 'p1', telegram_bot_token: 't1', secret: 's', name: 'x' },
    { api_key: 'new', smtp_pass: 'p2', telegram_bot_token: 't2', secret: 's2', name: 'y' }
  );
  assert.ok(out.includes('api_key=*'), 'api_key 应打码');
  assert.ok(out.includes('smtp_pass=*'), 'smtp_pass 应打码');
  assert.ok(out.includes('telegram_bot_token=*'), 'bot token 应打码');
  assert.ok(out.includes('secret=*'), 'secret 应打码');
  assert.ok(out.includes('name'), '普通字段不打码');
  // 关键：不得泄漏任何值
  assert.ok(!/old|new|p1|p2|t1|t2|s2/.test(out), '输出不得含任何敏感值');
});

test('L-4: diffKeys 统一 String 口径——"0" 与 0 视为相同（不产生噪声）', () => {
  assert.strictEqual(diffKeys({ a: 0 }, { a: '0' }), '', '0 与 "0" 应视为一致');
  assert.strictEqual(diffKeys({ a: 1 }, { a: '1' }), '');
  // 真实差异仍应检出
  assert.strictEqual(diffKeys({ a: 0 }, { a: '1' }), 'a');
});

test('L-4: diffKeys undefined / null / 缺失值视为空串（不误报）', () => {
  assert.strictEqual(diffKeys({ a: undefined }, { a: '' }), '');
  assert.strictEqual(diffKeys({ a: null }, { a: '' }), '');
  assert.strictEqual(diffKeys({ a: null }, {}), '');
  assert.strictEqual(diffKeys({}, { a: undefined }), '');
});

test('L-4: diffKeys 空对象/单侧缺失不抛错', () => {
  assert.doesNotThrow(() => diffKeys(undefined, undefined));
  assert.doesNotThrow(() => diffKeys({}, undefined));
  assert.doesNotThrow(() => diffKeys(undefined, { a: 1 }));
  assert.strictEqual(diffKeys(undefined, { a: 1 }), 'a');
});

test('L-4: diffKeys 值含逗号不破坏格式（因只输出键名）', () => {
  const out = diffKeys({ note: 'a,b,c' }, { note: 'x,y' });
  assert.strictEqual(out, 'note', '只输出键名，值与逗号无关');
});

test('L-4: diffKeys 布尔/数组等类型变化可检出', () => {
  assert.strictEqual(diffKeys({ f: false }, { f: true }), 'f');
  assert.strictEqual(diffKeys({ arr: [1] }, { arr: [1, 2] }), 'arr');
});
