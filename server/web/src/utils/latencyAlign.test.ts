import { describe, it, expect } from 'vitest';
import { alignOnTimestamps } from './latencyAlign';

describe('alignOnTimestamps（P1-10 多序列时间轴对齐）', () => {
  it('两序列时间点不一致时按并集对齐、缺失填 null，不再索引左移', () => {
    const a = { name: 'A', data: [{ t: 1, v: 10 }, { t: 3, v: 30 }] };
    const b = { name: 'B', data: [{ t: 2, v: 20 }, { t: 3, v: 33 }] };
    const out = alignOnTimestamps([a, b]);
    expect(out.labels).toEqual([1, 2, 3]);
    // 修前 A 按索引对齐到 t=1,2 → v=30 错挂到 t=2；现在值与时间戳一一对应
    expect(out.values[0]).toEqual([10, null, 30]);
    expect(out.values[1]).toEqual([null, 20, 33]);
  });

  it('首序列缺点时其余序列不左移', () => {
    const a = { name: 'A', data: [{ t: 5, v: 1 }] };
    const b = { name: 'B', data: [{ t: 4, v: 40 }, { t: 5, v: 50 }] };
    const out = alignOnTimestamps([a, b]);
    expect(out.labels).toEqual([4, 5]);
    expect(out.values[0]).toEqual([null, 1]);
    expect(out.values[1]).toEqual([40, 50]);
  });

  it('空序列与 null 值不破坏对齐', () => {
    const a = { name: 'A', data: [{ t: 2, v: null }, { t: 1, v: 7 }] };
    const b = { name: 'B', data: [] };
    const out = alignOnTimestamps([a, b]);
    expect(out.labels).toEqual([1, 2]);
    expect(out.values[0]).toEqual([7, null]);
    expect(out.values[1]).toEqual([null, null]);
  });
});
