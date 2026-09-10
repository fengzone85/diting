<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useChartTheme } from '../composables/useChartTheme';
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

function baseOption(): any {
  const c = colors.value;
  const color = props.color || '#38bdf8';
  return {
    backgroundColor: 'transparent',
    grid: { top: 30, right: 20, bottom: 30, left: 50 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: c.tooltipBg,
      borderColor: c.tooltipBorder,
      textStyle: { color: c.text },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: c.axisLine } },
      // 对齐 Komari LoadChart 的时间轴写法：字号 10 + hideOverlap。
      // 该卡片在三列网格里只有 ~370px 宽，默认 12px 字号会让时间刻度首尾相接
      // （实测 1h 时 9 个 "HH:mm" 连成一片）；hideOverlap 让 ECharts 丢弃重叠标签，
      // 实测同样宽度下标签数由 9 降到 6，间距约一倍。
      axisTick: { show: false },
      axisLabel: { color: c.text, fontSize: 10, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: c.splitLine, type: 'dashed' } },
      axisLabel: { color: c.text },
    },
    series: [{
      type: 'line',
      showSymbol: false,
      smooth: true,
      lineStyle: { color, width: 1.5 },
      areaStyle: { color: areaGradient(color) },
      data: props.data.map(d => [d.t, d.v]),
    }],
  };
}

function init() {
  if (!chartRef.value) return;
  chart = echarts.init(chartRef.value, undefined, { renderer: 'canvas' });
  chart.setOption(baseOption());
  // 标签疏密由容器宽度决定（hideOverlap 在 resize 后才会重算），故必须跟随宽度重排
  ro = new ResizeObserver(() => chart?.resize());
  ro.observe(chartRef.value);
}

watch(colors, () => chart?.setOption(baseOption(), true));

watch(() => props.data, (next) => {
  chart?.setOption({
    series: [{ data: next.map(d => [d.t, d.v]) }],
  });
}, { deep: true });

onMounted(init);
onUnmounted(() => { ro?.disconnect(); chart?.dispose(); });
</script>

<template>
  <div class="glass p-4">
    <h4 v-if="title" class="mb-3 text-sm font-medium text-content">{{ title }}</h4>
    <div ref="chartRef" class="h-48 w-full" />
  </div>
</template>
