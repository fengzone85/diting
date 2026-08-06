<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
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

const chartRef = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

function buildSeries() {
  return props.series.map(s => ({
    name: s.name,
    type: 'line' as const,
    showSymbol: false,
    smooth: true,
    lineStyle: { color: s.color, width: 2 },
    areaStyle: { color: s.color, opacity: 0.12 },
    data: s.data.map(d => [d.t, d.v]),
  }));
}

function init() {
  if (!chartRef.value) return;
  chart = echarts.init(chartRef.value, undefined, { renderer: 'canvas' });
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { top: 36, right: 20, bottom: 30, left: 56 },
    tooltip: { trigger: 'axis' },
    legend: {
      top: 0,
      textStyle: { color: '#cbd5e1' },
      data: props.series.map(s => s.name),
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#475569' } },
      axisLabel: { color: '#94a3b8' },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '#334155', type: 'dashed' } },
      axisLabel: { color: '#94a3b8' },
    },
    series: buildSeries(),
  });
}

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
    <h4 v-if="title" class="mb-3 text-sm font-medium text-slate-300">{{ title }}</h4>
    <div ref="chartRef" class="h-48 w-full" />
  </div>
</template>
