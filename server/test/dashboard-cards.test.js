const test = require('node:test');
const assert = require('node:assert');
const { DASHBOARD_CARD_KEYS, validateDashboardCardKeys } = require('../src/validate');

test('卡片键白名单覆盖现有 8 张仪表盘卡片', () => {
  assert.deepStrictEqual(DASHBOARD_CARD_KEYS, [
    'total', 'online', 'offline', 'monthly_cost',
    'avg_cpu', 'avg_mem', 'db_size', 'public_nodes',
  ]);
});

test('合法键按提交顺序保留', () => {
  const r = validateDashboardCardKeys(['online', 'total', 'monthly_cost']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, ['online', 'total', 'monthly_cost']);
});

test('重复键去重且保留首次出现的位置', () => {
  const r = validateDashboardCardKeys(['online', 'total', 'online']);
  assert.deepStrictEqual(r.value, ['online', 'total']);
});

test('白名单外的键与非字符串值被丢弃', () => {
  const r = validateDashboardCardKeys(['online', 'evil', 42, null, {}, 'avg_cpu']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, ['online', 'avg_cpu']);
});

test('空数组合法（视为未配置，前端回退默认全量）', () => {
  const r = validateDashboardCardKeys([]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, []);
});

test('非数组入参报错', () => {
  for (const bad of [undefined, null, 'total', 1, {}]) {
    const r = validateDashboardCardKeys(bad);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'card_keys_invalid');
  }
});

test('超长数组不会溢出（只保留白名单内键）', () => {
  const r = validateDashboardCardKeys(Array.from({ length: 1000 }, (_, i) => `k${i}`));
  assert.deepStrictEqual(r.value, []);
});
