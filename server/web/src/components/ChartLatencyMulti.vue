<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useChartTheme } from '../composables/useChartTheme';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ChartPoint } from '../services/types';

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export interface LatencySeries {
  name: string;
  color: string;
  data: ChartPoint[];
}

const props = defineProps<{
  title?: string;
  series: LatencySeries[];
}>();

const PALETTE = ['#f472b6', '#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185'];

const { colors } = useChartTheme();
const chartRef = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let ro: ResizeObserver | null = null;

// Komari 风格：线条下方从颜色向透明做垂直线性渐变
function areaGradient(color: string): any {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: hexToRgba(color, 0.2) },
    { offset: 1, color: hexToRgba(color, 0) },
  ]);
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 探测数据上报间隔（ms）：从首个 series 的时间戳推断
function detectInterval(series: LatencySeries[]): number {
  for (const s of series) {
    const d = s.data;
    for (let i = 1; i < d.length; i++) {
      const dt = d[i].t - d[i - 1].t;
      if (dt > 0) return dt;
    }
  }
  return 30000; // 默认 30s
}

// 对齐 Komari：按探测间隔做时间桶聚合（最小 800ms / 最大 6000ms 桶宽）
// 同一桶内取最后一个有效点（null 跳过），把点数压到 ~区间长度/桶宽
function bucketDownsample(series: LatencySeries[]): LatencySeries[] {
  const interval = detectInterval(series);
  const bucket = Math.min(6000, Math.max(800, Math.floor(interval * 1000 * 0.25)));
  return series.map((s) => {
    const map = new Map<number, { t: number; v: number | null }>();
    const order: number[] = [];
    for (const p of s.data) {
      const key = Math.floor(p.t / bucket) * bucket;
      if (!map.has(key)) { map.set(key, { t: p.t, v: p.v }); order.push(key); }
      else { map.get(key)!.t = p.t; if (p.v != null) map.get(key)!.v = p.v; }
    }
    const data = order
      .map(k => map.get(k)!)
      .sort((a, b) => a.t - b.t)
      .map(o => ({ t: o.t, v: o.v }));
    return { name: s.name, color: s.color, data };
  });
}

// 次级保护：桶聚合后若仍过多（如后端未限流），均匀抽稀到上限，避免 ECharts 卡顿
function capSeries(series: LatencySeries[], max = 2000): LatencySeries[] {
  return series.map((s) => {
    if (s.data.length <= max) return s;
    const step = s.data.length / max;
    const data = [];
    for (let i = 0; i < max; i++) data.push(s.data[Math.floor(i * step)]);
    return { name: s.name, color: s.color, data };
  });
}

function buildSeries() {
  const ds = capSeries(bucketDownsample(props.series));
  // 类目轴：所有 series 共享同一时间戳序列（桶聚合后已对齐），data 为纯值数组
  const labels = ds[0] ? ds[0].data.map(d => d.t) : [];
  return {
    labels,
    series: ds.map((s, i) => ({
      name: s.name,
      type: 'line' as const,
      showSymbol: false,
      smooth: 0.1,
      connectNulls: false,
      lineStyle: { color: s.color || PALETTE[i % PALETTE.length], width: 1.5 },
      areaStyle: { color: areaGradient(s.color || PALETTE[i % PALETTE.length]) },
      data: s.data.map(d => d.v),
    })),
  };
}

function fmtTime(t: number, showDate: boolean): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  if (showDate) return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function baseOption(): any {
  const c = colors.value;
  const built = buildSeries();
  const labels = built.labels;
  let span = 0;
  if (labels.length > 1) span = (labels[labels.length - 1] - labels[0]) / 3600000; // hours
  const showDate = span > 24;
  return {
    backgroundColor: 'transparent',
    animation: false,
    legend: {
      top: 2,
      textStyle: { fontSize: 11 },
      icon: 'roundRect',
      data: built.series.map(s => ({ name: s.name, textStyle: { color: s.lineStyle.color } })),
    },
    grid: { top: 34, right: 20, bottom: 30, left: 52 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: c.tooltipBg,
      borderColor: c.tooltipBorder,
      textStyle: { color: c.text },
      axisPointer: { type: 'cross', label: { backgroundColor: c.splitLine } },
    },
    xAxis: {
      type: 'category',
      data: labels.map(t => fmtTime(t, showDate)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: c.axisLine } },
      axisLabel: { color: c.text, fontSize: 11, hideOverlap: true },
      axisTick: { show: false },
      splitLine: { show: true, lineStyle: { color: c.splitLine } },
    },
    yAxis: {
      type: 'value',
      name: 'ms',
      nameTextStyle: { color: c.text },
      splitLine: { lineStyle: { color: c.splitLine, type: 'dashed' } },
      axisLabel: { color: c.text },
      axisLine: { show: true, lineStyle: { color: c.axisLine } },
    },
    series: built.series,
  };
}

function init() {
  if (!chartRef.value) return;
  chart = echarts.init(chartRef.value, undefined, { renderer: 'canvas' });
  chart.setOption(baseOption());
  ro = new ResizeObserver(() => chart?.resize());
  ro.observe(chartRef.value);
}

function resize() { nextTick(() => chart?.resize()); }

watch(colors, () => chart?.setOption(baseOption(), true));

watch(() => props.series, () => {
  const built = buildSeries();
  chart?.setOption({
    xAxis: { data: built.labels.map(t => fmtTime(t, (built.labels.length > 1 ? (built.labels[built.labels.length - 1] - built.labels[0]) / 3600000 : 0) > 24)) },
    series: built.series,
    legend: { data: built.series.map(s => ({ name: s.name, textStyle: { color: s.lineStyle.color } })) },
  });
}, { deep: true });

onMounted(init);
onUnmounted(() => { ro?.disconnect(); chart?.dispose(); });

defineExpose({ resize });
</script>

<template>
  <div>
    <h4 v-if="title" class="mb-2 text-sm font-medium text-content">{{ title }}</h4>
    <div ref="chartRef" class="h-56 w-full" />
  </div>
</template>
