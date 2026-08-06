<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
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

const chartRef = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

function buildSeries() {
  return props.series.map((s, i) => ({
    name: s.name,
    type: 'line' as const,
    showSymbol: false,
    smooth: true,
    lineStyle: { color: s.color || PALETTE[i % PALETTE.length], width: 2 },
    data: s.data.map(d => [d.t, d.v]),
  }));
}

function init() {
  if (!chartRef.value) return;
  chart = echarts.init(chartRef.value, undefined, { renderer: 'canvas' });
  chart.setOption({
    backgroundColor: 'transparent',
    legend: {
      top: 2,
      textStyle: { color: '#cbd5e1', fontSize: 11 },
      icon: 'roundRect',
    },
    grid: { top: 34, right: 20, bottom: 30, left: 52 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: { backgroundColor: '#334155' } },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#475569' } },
      axisLabel: { color: '#94a3b8' },
      splitLine: { show: true, lineStyle: { color: '#1e293b' } },
    },
    yAxis: {
      type: 'value',
      name: 'ms',
      nameTextStyle: { color: '#94a3b8' },
      splitLine: { lineStyle: { color: '#334155', type: 'dashed' } },
      axisLabel: { color: '#94a3b8' },
      axisLine: { show: true, lineStyle: { color: '#475569' } },
    },
    series: buildSeries(),
  });
}

watch(() => props.series, () => {
  chart?.setOption({ series: buildSeries() });
}, { deep: true });

onMounted(init);
onUnmounted(() => chart?.dispose());
</script>

<template>
  <div class="glass p-4">
    <h4 v-if="title" class="mb-2 text-sm font-medium text-slate-300">{{ title }}</h4>
    <div ref="chartRef" class="h-56 w-full" />
  </div>
</template>
