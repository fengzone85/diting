const test = require('node:test');
const assert = require('node:assert');
const {
  DASHBOARD_WIDGET_IDS, DASHBOARD_WIDTHS, DASHBOARD_HEIGHTS, validateDashboardLayout,
} = require('../src/validate');

test('卡片键白名单：9 张单指标卡 + 10 张复合卡', () => {
  assert.deepStrictEqual(DASHBOARD_WIDGET_IDS, [
    'total', 'online', 'offline', 'monthly_cost', 'remaining_value',
    'avg_cpu', 'avg_mem', 'db_size', 'public_nodes',
    'overview', 'capacity', 'cpu_rank', 'mem_rank', 'disk_rank',
    'traffic', 'expiry', 'ping', 'groups', 'shortcuts',
  ]);
  assert.deepStrictEqual(DASHBOARD_WIDTHS, ['compact', 'wide', 'full']);
  assert.deepStrictEqual(DASHBOARD_HEIGHTS, ['short', 'normal', 'tall']);
});

test('合法布局按提交顺序保留，宽度/高度原样透传', () => {
  const r = validateDashboardLayout([
    { id: 'online', width: 'wide', height: 'normal' },
    { id: 'total', width: 'compact', height: 'short' },
  ]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, [
    { id: 'online', width: 'wide', height: 'normal' },
    { id: 'total', width: 'compact', height: 'short' },
  ]);
});

test('重复 id 只保留首次出现的位置', () => {
  const r = validateDashboardLayout([
    { id: 'online', width: 'wide', height: 'tall' },
    { id: 'total', width: 'compact', height: 'short' },
    { id: 'online', width: 'full', height: 'short' },
  ]);
  assert.deepStrictEqual(r.value.map((w) => w.id), ['online', 'total']);
  assert.strictEqual(r.value[0].width, 'wide');
});

test('非法宽度/高度回退到默认，白名单外 id 与非对象元素被丢弃', () => {
  const r = validateDashboardLayout([
    { id: 'avg_cpu', width: 'huge', height: 'giant' },
    { id: 'evil', width: 'wide', height: 'tall' },
    null,
    'total',
    { id: 42 },
    { id: 'db_size' },
  ]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, [
    { id: 'avg_cpu', width: 'compact', height: 'short' },
    { id: 'db_size', width: 'compact', height: 'short' },
  ]);
});

test('空数组合法（用户移除全部卡片）', () => {
  const r = validateDashboardLayout([]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, []);
});

test('非数组入参报错', () => {
  for (const bad of [undefined, null, 'total', 1, {}]) {
    const r = validateDashboardLayout(bad);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'layout_invalid');
  }
});

test('超长数组不会溢出（只保留白名单内 id，且各一次）', () => {
  const r = validateDashboardLayout(Array.from({ length: 1000 }, (_, i) => ({ id: `k${i}` })));
  assert.deepStrictEqual(r.value, []);
  const dup = validateDashboardLayout(Array.from({ length: 1000 }, () => ({ id: 'online' })));
  assert.deepStrictEqual(dup.value.map((w) => w.id), ['online']);
});
