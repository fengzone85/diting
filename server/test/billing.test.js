const test = require('node:test');
const assert = require('node:assert');
const { computeBilling, summarizeBilling } = require('../src/billing');

// 固定「今天」为 2026-10-21（UTC），便于断言天数与折算金额
const NOW = Date.parse('2026-10-21T00:00:00Z');

test('价格 0 → 不显示，不参与任何折算', () => {
  const b = computeBilling({ price: 0, billing_cycle: 30, expire_at: '2026-12-31' }, NOW);
  assert.equal(b.billing_status, 'unset');
  assert.equal(b.remaining_value, null);
  assert.equal(b.remaining_days, null);
});

test('价格 -1 → 免费，剩余价值 0', () => {
  const b = computeBilling({ price: -1, billing_cycle: 30, expire_at: '2026-12-31' }, NOW);
  assert.equal(b.billing_status, 'free');
  assert.equal(b.remaining_value, 0);
});

test('到期日为「长期」→ 不折算，仅有月均支出', () => {
  const b = computeBilling({ price: 300, billing_cycle: 365, expire_at: '' }, NOW);
  assert.equal(b.billing_status, 'long_term');
  assert.equal(b.remaining_value, null);
  assert.equal(b.monthly_cost, 24.66); // 300/365*30
});

test('剩余价值 = 价格 × 剩余天数 ÷ 周期天数（UTC 整日）', () => {
  // 2026-10-21 → 2026-12-31 共 71 天；年付 365 → 300*71/365
  const b = computeBilling({ price: 300, billing_cycle: 365, expire_at: '2026-12-31' }, NOW);
  assert.equal(b.remaining_days, 71);
  assert.equal(b.remaining_value, 58.36);
  assert.equal(b.billing_status, 'active');
});

test('当天到期仍按 0 天 → 已过期、剩余价值 0', () => {
  const b = computeBilling({ price: 30, billing_cycle: 30, expire_at: '2026-10-21' }, NOW);
  assert.equal(b.remaining_days, 0);
  assert.equal(b.billing_status, 'expired');
  assert.equal(b.remaining_value, 0);
});

test('已过期不产生负值', () => {
  const b = computeBilling({ price: 30, billing_cycle: 30, expire_at: '2026-09-01' }, NOW);
  assert.equal(b.billing_status, 'expired');
  assert.equal(b.remaining_value, 0);
});

test('剩余天数超过一个周期时按一期价格封顶', () => {
  // 月付 30 元 / 30 天，但到期日在 90 天后 → 最多按一期计
  const b = computeBilling({ price: 30, billing_cycle: 30, expire_at: '2027-01-19' }, NOW);
  assert.equal(b.remaining_days, 90);
  assert.equal(b.remaining_value, 30);
});

test('一次性（billing_cycle = -1）无周期可折算，按原价计入', () => {
  const b = computeBilling({ price: 120, billing_cycle: -1, expire_at: '2027-10-21' }, NOW);
  assert.equal(b.billing_status, 'one_off');
  assert.equal(b.remaining_value, 120);
  assert.equal(b.monthly_cost, null);
});

test('日期非法 → invalid，不折算', () => {
  const b = computeBilling({ price: 30, billing_cycle: 30, expire_at: 'not-a-date' }, NOW);
  assert.equal(b.billing_status, 'invalid');
  assert.equal(b.remaining_value, null);
});

test('汇总：总价值/剩余价值/月均支出只统计正价节点', () => {
  const agents = [
    { price: 300, billing_cycle: 365, expire_at: '2026-12-31', currency: '¥' },
    { price: 30, billing_cycle: 30, expire_at: '2026-10-31', currency: '¥' },
    { price: -1, billing_cycle: 30, expire_at: '2026-12-31', currency: '¥' },
    { price: 0, billing_cycle: 30, expire_at: '', currency: '¥' },
  ];
  const s = summarizeBilling(agents, NOW);
  assert.equal(s.count, 4);
  assert.equal(s.total_value, 330);
  assert.equal(s.monthly_cost, 54.66);        // 24.66 + 30
  assert.equal(s.remaining_value, 68.36);     // 58.36 + 10
});

test('UTC 口径：临界日期不受本地时区影响', () => {
  // 以 UTC 23:30 作为「现在」，仍是 2026-10-21 → 剩余 71 天
  const b = computeBilling({ price: 365, billing_cycle: 365, expire_at: '2026-12-31' }, Date.parse('2026-10-21T23:30:00Z'));
  assert.equal(b.remaining_days, 71);
});
