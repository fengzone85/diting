<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ChartPoint } from '../services/types';

echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

const props = defineProps<{
  title?: string;
  data: ChartPoint[];
  color?: string;
}>();

const chartRef = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

function init() {
  if (!chartRef.value) return;
  chart = echarts.init(chartRef.value, undefined, { renderer: 'canvas' });
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { top: 30, right: 20, bottom: 30, left: 50 },
    tooltip: { trigger: 'axis' },
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
    series: [{
      type: 'line',
      showSymbol: false,
      smooth: true,
      lineStyle: { color: props.color || '#38bdf8', width: 2 },
      areaStyle: { color: props.color || '#38bdf8', opacity: 0.15 },
      data: props.data.map(d => [d.t, d.v]),
    }],
  });
}

watch(() => props.data, (next) => {
  chart?.setOption({
    series: [{ data: next.map(d => [d.t, d.v]) }],
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
