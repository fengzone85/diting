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
  return ds.map((s, i) => ({
    name: s.name,
    type: 'line' as const,
    showSymbol: false,
    smooth: 0.1,
    connectNulls: false,
    lineStyle: { color: s.color || PALETTE[i % PALETTE.length], width: 1.5 },
    data: s.data.map(d => [d.t, d.v]),
  }));
}

function baseOption(): any {
  const c = colors.value;
  return {
    backgroundColor: 'transparent',
    animation: false,
    legend: {
      top: 2,
      textStyle: { color: c.text, fontSize: 11 },
      icon: 'roundRect',
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
      type: 'time',
      axisLine: { lineStyle: { color: c.axisLine } },
      axisLabel: { color: c.text },
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
    series: buildSeries(),
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
  chart?.setOption({ series: buildSeries() });
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
