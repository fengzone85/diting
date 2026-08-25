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

function baseOption(): any {
  const c = colors.value;
  return {
    backgroundColor: 'transparent',
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
