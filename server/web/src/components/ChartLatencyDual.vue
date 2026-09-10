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

// 磁盘速率原始值为 B/s，峰值常达十亿量级（如 5346138861），直接显示会占满坐标宽度。
// 这里先把数据换算到一个统一单位（KB/s / MB/s / GB/s）再交给 ECharts：
// 若把原始字节直接交给它，它会按「字节」取整齐刻度（如 6,600,000），
// 除以 1024 显示出来就成了 6.3 MB/s 这种碎值；换算后再取刻度才能得到 2/4/6 MB/s 这样的整数。
const RATE_UNITS = [
  { label: 'GB/s', scale: 1024 ** 3 },
  { label: 'MB/s', scale: 1024 ** 2 },
  { label: 'KB/s', scale: 1024 },
  { label: 'B/s', scale: 1 },
];
// 本次采用的单位：由数据峰值决定，yAxis 与 tooltip 共用，故在 buildSeries 时刷新
let rateUnit = RATE_UNITS[RATE_UNITS.length - 1];

function pickRateUnit(peak: number) {
  return RATE_UNITS.find(u => peak >= u.scale) ?? RATE_UNITS[RATE_UNITS.length - 1];
}

// 刻度/悬停文案：最多两位小数并去掉多余的 0（2.00 → 2、0.50 → 0.5）
function fmtTick(v: number): string {
  return String(parseFloat(v.toFixed(2)));
}

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

function buildSeries() {
  let peak = 0;
  for (const s of props.series) {
    for (const d of s.data) if (d.v != null && d.v > peak) peak = d.v;
  }
  rateUnit = pickRateUnit(peak);
  return props.series.map(s => ({
    name: s.name,
    type: 'line' as const,
    showSymbol: false,
    smooth: true,
    lineStyle: { color: s.color, width: 1.5 },
    areaStyle: { color: areaGradient(s.color) },
    // null 原样保留，ECharts 才会画出断点（勿转成 0）
    data: s.data.map(d => [d.t, d.v == null ? null : d.v / rateUnit.scale]),
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
      // 悬停数值与轴刻度同口径（已换算到 rateUnit），避免出现 5346138861 这类长数字
      valueFormatter: (v: unknown) =>
        typeof v === 'number' ? `${fmtTick(v)} ${rateUnit.label}` : String(v ?? '-'),
    },
    legend: {
      top: 0,
      textStyle: { color: c.text },
      data: props.series.map(s => s.name),
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: c.axisLine } },
      // 同 ChartLatency：对齐 Komari LoadChart 的 10px 字号 + hideOverlap，
      // 避免三列网格下时间刻度首尾相接
      axisTick: { show: false },
      axisLabel: { color: c.text, fontSize: 10, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      // 单位挂在轴名上（同 ChartLatencyMulti 的 'ms'），刻度本身只留数字：
      // 既省横向宽度，也让刻度值一眼可读
      name: rateUnit.label,
      nameTextStyle: { color: c.text, fontSize: 10 },
      splitLine: { lineStyle: { color: c.splitLine, type: 'dashed' } },
      axisLabel: { color: c.text, fontSize: 10, formatter: fmtTick },
    },
    series: buildSeries(),
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

watch(() => props.series, (next) => {
  if (!chart) return;
  const series = buildSeries(); // 内部按新数据的峰值刷新 rateUnit
  chart.setOption({
    legend: { data: next.map(s => s.name) },
    // 峰值变化可能跨单位（如 KB/s → MB/s），轴名要跟着更新
    yAxis: { name: rateUnit.label },
    series,
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
