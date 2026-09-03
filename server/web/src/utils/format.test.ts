import { describe, it, expect } from 'vitest';
import { formatBytes, formatBitsPerSecond, formatDuration, formatPercent, formatNumber } from './format';

describe('formatBytes', () => {
  it('handles undefined/null/NaN', () => {
    expect(formatBytes(undefined)).toBe('-');
    expect(formatBytes(null as unknown as undefined)).toBe('-');
    expect(formatBytes(NaN)).toBe('-');
  });

  it('returns 0 B for zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes to human readable', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});

describe('formatBitsPerSecond', () => {
  it('formats bps using decimal base', () => {
    expect(formatBitsPerSecond(0)).toBe('0 bps');
    expect(formatBitsPerSecond(1000)).toBe('1 Kbps');
    expect(formatBitsPerSecond(1500)).toBe('1.5 Kbps');
    expect(formatBitsPerSecond(1_000_000)).toBe('1 Mbps');
  });
});

describe('formatDuration', () => {
  it('returns - for invalid values', () => {
    expect(formatDuration(undefined)).toBe('-');
  });

  it('formats seconds to days/hours/minutes', () => {
    expect(formatDuration(59)).toBe('<1m');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(90061)).toBe('1d 1h 1m');
  });
});

describe('formatPercent', () => {
  it('returns - for invalid values', () => {
    expect(formatPercent(undefined)).toBe('-');
  });

  it('formats percentage with default decimals', () => {
    expect(formatPercent(12.345)).toBe('12.3%');
    expect(formatPercent(0)).toBe('0.0%');
  });
});

describe('formatNumber', () => {
  it('returns - for invalid values', () => {
    expect(formatNumber(undefined)).toBe('-');
  });

  it('formats number with fixed decimals', () => {
    expect(formatNumber(12.345)).toBe('12.35');
    expect(formatNumber(5)).toBe('5.00');
  });
});
