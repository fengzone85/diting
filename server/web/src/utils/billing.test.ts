// 计费口径常量：UI 下拉、格式化和后端字段共用这一份定义，
// 符号/顺序/语义值（-1 一次性、0 免费）一旦被改会静默影响展示与统计。
import { describe, it, expect } from 'vitest';
import { CURRENCIES, BILLING_CYCLES, DEFAULT_CURRENCY, DEFAULT_CYCLE } from './billing';

describe('billing 选项口径', () => {
  it('货币 9 种、符号不重复，首项为默认人民币', () => {
    expect(CURRENCIES).toHaveLength(9);
    expect(new Set(CURRENCIES.map((c) => c.symbol)).size).toBe(9);
    expect(CURRENCIES[0]).toEqual({ symbol: '¥', key: 'cny' });
  });

  it('计费周期保留 -1 一次性 / 0 免费 的语义值', () => {
    expect(BILLING_CYCLES[0]).toEqual({ value: -1, key: 'once' });
    expect(BILLING_CYCLES[1]).toEqual({ value: 0, key: 'free' });
    expect(BILLING_CYCLES.map((c) => c.value)).toEqual([-1, 0, 30, 60, 90, 180, 365, 730, 1095]);
  });

  it('默认值与 db 侧约定一致（¥ / 30 天）', () => {
    expect(DEFAULT_CURRENCY).toBe('¥');
    expect(DEFAULT_CYCLE).toBe(30);
  });
});
