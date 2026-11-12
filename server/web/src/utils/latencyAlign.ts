// P1-10：多序列时间轴对齐。
// 修前：各 series 独立分桶后用 ds[0] 的时间轴 + 索引取值，某序列缺点时后续值
// 整体左移，图与真实时间错位。这里按时间戳并集对齐、缺失填 null（配合
// connectNulls:false 保留断点），值与时间戳一一对应。
export interface AlignablePoint {
  t: number;
  v: number | null;
}

export function alignOnTimestamps<T extends { data: AlignablePoint[] }>(
  series: T[],
): { labels: number[]; values: (number | null)[][] } {
  const tsSet = new Set<number>();
  for (const s of series) for (const d of s.data) tsSet.add(d.t);
  const labels = [...tsSet].sort((a, b) => a - b);
  const values = series.map((s) => {
    const byTs = new Map<number, number | null>();
    for (const d of s.data) byTs.set(d.t, d.v);
    return labels.map((t) => (byTs.has(t) ? byTs.get(t)! : null));
  });
  return { labels, values };
}
