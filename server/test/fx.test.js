// 汇率解析口径：解析错会让整张汇率表变成「缺汇率」，必须单独锁住。
const test = require('node:test');
const assert = require('node:assert');
const { pickRates, PROVIDERS } = require('../src/fx');

test('pickRates：两种响应形状都能解析，键统一成 ISO', () => {
  assert.deepEqual(pickRates({ base: 'USD', date: '2026-11-12', rates: { CNY: 7.2 } }), { CNY: 7.2 });
  assert.deepEqual(pickRates({ result: 'success', base_code: 'USD', rates: { '€': 0.9 } }), { EUR: 0.9 });
  assert.deepEqual(pickRates({ rates: { $: 1, '¥': 7 } }), { USD: 1, CNY: 7 });
});

test('pickRates：丢弃非正数 / 非数字 / 未知币种，全空返回 null', () => {
  assert.deepEqual(pickRates({ rates: { CNY: 0, USD: -1, EUR: 'abc', JPY: 150 } }), { JPY: 150 });
  assert.equal(pickRates({ rates: { CNY: 0 } }), null);
  assert.equal(pickRates({}), null);
  assert.equal(pickRates(null), null);
  assert.equal(pickRates({ rates: 'x' }), null);
});

test('汇率源固定域名且只用 https（防 SSRF）', () => {
  assert.ok(PROVIDERS.length >= 2);
  for (const p of PROVIDERS) {
    assert.match(p.url('USD', 'CNY'), /^https:\/\//);
    assert.ok(p.url('USD', 'CNY').includes(p.host));
  }
});
