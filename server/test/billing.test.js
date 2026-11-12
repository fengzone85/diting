const test = require('node:test');
const assert = require('node:assert');
const {
  computeBilling, summarizeBilling, summarizeByCurrency, convertSummary, normalizeCurrency,
} = require('../src/billing');

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

test('summarizeByCurrency：按币种分桶，绝不跨币种相加', () => {
  const agents = [
    { price: 100, billing_cycle: 30, expire_at: '2026-12-31', currency: '$' },
    { price: 200, billing_cycle: 30, expire_at: '2026-12-31', currency: '¥' },
    { price: 50, billing_cycle: 30, expire_at: '2026-12-31', currency: '€' },
    { price: -1, billing_cycle: 30, expire_at: '2026-12-31', currency: '¥' },
  ];
  const s = summarizeByCurrency(agents, NOW);
  assert.equal(s.count, 4);
  assert.equal(s.by_currency.USD.total_value, 100);
  assert.equal(s.by_currency.CNY.total_value, 200);   // 免费节点不抬高总价值
  assert.equal(s.by_currency.EUR.total_value, 50);
  assert.equal(s.by_currency.USD.remaining_value, 100);
});

test('币种归一化：符号与 ISO 混用归到同一桶，未知币种不被猜成 CNY', () => {
  const s = summarizeByCurrency([
    { price: 100, currency: '$', billing_cycle: 30 },
    { price: 50, currency: 'USD', billing_cycle: 30 },
    { price: 30, currency: 'XYZ', billing_cycle: 30 },
  ], NOW);
  assert.equal(s.by_currency.USD.total_value, 150);
  assert.equal(s.by_currency.XYZ.total_value, 30);   // 未知码原样保留
  assert.equal(normalizeCurrency('¥'), 'CNY');       // 存量符号
  assert.equal(normalizeCurrency('JP¥'), 'JPY');
  assert.equal(normalizeCurrency('usd'), 'USD');
  assert.equal(normalizeCurrency('XYZ'), null);
});

test('convertSummary：按手工汇率折算，缺汇率的币种不计入总额并进 missing', () => {
  const agents = [
    { price: 100, billing_cycle: 30, expire_at: '2026-12-31', currency: '$' },
    { price: 200, billing_cycle: 30, expire_at: '2026-12-31', currency: '¥' },
    { price: 50, billing_cycle: 30, expire_at: '2026-12-31', currency: '€' },
  ];
  const s = summarizeByCurrency(agents, NOW);
  const conv = convertSummary(s, { base_currency: '¥', rates: { $: 7.2 }, updated_at: 123 });
  assert.equal(conv.base_currency, '¥');            // 兼容旧前端：仍是符号
  assert.equal(conv.base_currency_code, 'CNY');
  assert.equal(conv.total_value, 200 + 720);        // € 缺汇率，不计入
  assert.deepEqual(conv.missing, ['EUR']);
  assert.equal(conv.by_currency.EUR.rate, null);
  assert.equal(conv.by_currency.EUR.symbol, '€');
  assert.equal(conv.by_currency.USD.converted.total_value, 720);
  assert.equal(conv.fx_updated_at, 123);
});

test('convertSummary：非法/非正汇率视同缺失，不做隐式 1:1', () => {
  const s = summarizeByCurrency([
    { price: 100, billing_cycle: 30, expire_at: '2026-12-31', currency: '$' },
  ], NOW);
  for (const rates of [{ $: 0 }, { $: -1 }, { $: 'abc' }]) {
    const conv = convertSummary(s, { base_currency: 'CNY', rates });
    assert.equal(conv.total_value, 0);
    assert.deepEqual(conv.missing, ['USD']);
  }
});

test('convertSummary：标准货币非法时回退 ¥（避免前端拿到空符号）', () => {
  const conv = convertSummary({ by_currency: {} }, { base_currency: 'XYZ', rates: {} });
  assert.equal(conv.base_currency, '¥');
});
