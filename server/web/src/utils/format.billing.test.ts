import { describe, it, expect } from 'vitest';
import { formatBytesPerSecond, formatCurrency, formatRemaining } from './format';

describe('formatBytesPerSecond', () => {
  it('空值/NaN 返回占位符，0 单独处理', () => {
    expect(formatBytesPerSecond(undefined)).toBe('-');
    expect(formatBytesPerSecond(null as unknown as number)).toBe('-');
    expect(formatBytesPerSecond(NaN)).toBe('-');
    expect(formatBytesPerSecond(0)).toBe('0 B/s');
  });

  it('按 1024 进位并保留小数位', () => {
    expect(formatBytesPerSecond(1024)).toBe('1 KB/s');
    expect(formatBytesPerSecond(1536, 1)).toBe('1.5 KB/s');
    expect(formatBytesPerSecond(1024 * 1024 * 1024)).toBe('1 GB/s');
    // 超过最大单位（TB/s）后不再进一位，数值继续放大到 TB 档
    expect(formatBytesPerSecond(1024 ** 5 * 8)).toBe('8192 TB/s');
    expect(formatBytesPerSecond(1024, -1)).toBe('1 KB/s');     // decimals<0 归零
  });
});

describe('formatCurrency', () => {
  it('空值返回占位符', () => {
    expect(formatCurrency(undefined)).toBe('-');
    expect(formatCurrency(null as unknown as number)).toBe('-');
    expect(formatCurrency(NaN)).toBe('-');
  });

  it('拼接货币符号与两位小数', () => {
    expect(formatCurrency(50)).toBe('¥50.00');
    expect(formatCurrency(12.5, '$')).toBe('$12.50');
  });
});

describe('formatRemaining', () => {
  const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

  it('无到期时间 / 非法时间 → 长期', () => {
    expect(formatRemaining(undefined)).toEqual({ text: '—', status: 'long_term' });
    expect(formatRemaining('not-a-date')).toEqual({ text: '—', status: 'long_term' });
  });

  it('已过期', () => {
    expect(formatRemaining(days(-1))).toEqual({ text: '已过期', status: 'expired' });
  });

  it('按剩余天数分级：critical / warning / normal / long_term', () => {
    expect(formatRemaining(days(3)).status).toBe('critical');
    expect(formatRemaining(days(20)).status).toBe('warning');
    expect(formatRemaining(days(100)).status).toBe('normal');
    expect(formatRemaining(days(400)).status).toBe('long_term');
  });

  it('文案：不足 30 天只显示天数，超过则显示月+天', () => {
    expect(formatRemaining(days(10)).text).toBe('10 天');
    expect(formatRemaining(days(45)).text).toBe('1 月 15 天');
  });
});
