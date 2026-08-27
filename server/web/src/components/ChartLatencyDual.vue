<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useChartTheme } from '../composables/useChartTheme';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ChartPoint } from '../services/types';

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

interface SeriesSpec {
  name: string;
  data: ChartPoint[];
  color: string;
}

const props = defineProps<{
  title?: string;
  series: SeriesSpec[];
}>();

const { colors } = useChartTheme();
const chartRef = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

// Komari 风格：线条下方从颜色向透明做垂直线性渐变
function areaGradient(color: string): any {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: hexToRgba(color, 0.35) },
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

function buildSeries() {
  return props.series.map(s => ({
    name: s.name,
    type: 'line' as const,
    showSymbol: false,
    smooth: true,
    lineStyle: { color: s.color, width: 1.5 },
    areaStyle: { color: areaGradient(s.color) },
    data: s.data.map(d => [d.t, d.v]),
  }));
}

function baseOption(): any {
  const c = colors.value;
  return {
    backgroundColor: 'transparent',
    grid: { top: 36, right: 20, bottom: 30, left: 56 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: c.tooltipBg,
      borderColor: c.tooltipBorder,
      textStyle: { color: c.text },
    },
    legend: {
      top: 0,
      textStyle: { color: c.text },
      data: props.series.map(s => s.name),
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: c.axisLine } },
      axisLabel: { color: c.text },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: c.splitLine, type: 'dashed' } },
      axisLabel: { color: c.text },
    },
    series: buildSeries(),
  };
}

function init() {
  if (!chartRef.value) return;
  chart = echarts.init(chartRef.value, undefined, { renderer: 'canvas' });
  chart.setOption(baseOption());
}

watch(colors, () => chart?.setOption(baseOption(), true));

watch(() => props.series, (next) => {
  chart?.setOption({
    legend: { data: next.map(s => s.name) },
    series: buildSeries(),
  });
}, { deep: true });

onMounted(init);
onUnmounted(() => chart?.dispose());
</script>

<template>
  <div class="glass p-4">
    <h4 v-if="title" class="mb-3 text-sm font-medium text-content">{{ title }}</h4>
    <div ref="chartRef" class="h-48 w-full" />
  </div>
</template>
