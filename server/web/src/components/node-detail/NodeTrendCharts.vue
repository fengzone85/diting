<script setup lang="ts">
// 六图区：时间范围切换 + CPU/内存/磁盘IO/负载(进程)/温度/swap。
import { computed, markRaw } from 'vue';
import ChartLatency from '../ChartLatency.vue';
import ChartLatencyDual from '../ChartLatencyDual.vue';
import { Cpu, Memory, HardDisk, DashboardOne, Thermometer, Switch } from '@icon-park/vue-next';
import { t } from '../../composables/useI18n';
import { CHART_RANGES } from '../../composables/useNodeDetail';
import { formatBytes, formatPercent } from '../../utils/format';
import type { Agent, ChartPoint, SparklinePoint } from '../../services/types';

const props = defineProps<{
  agent: Agent;
  rows: SparklinePoint[];
  range: string;
  loading: boolean;
}>();

defineEmits<{
  (e: 'switch-range', range: string): void;
  (e: 'open-custom'): void;
}>();

// 六图标题图标：markRaw 避免组件对象被 reactive 代理；图标统一单色（继承标题文字色）。
const CHART_ICONS = {
  cpu: markRaw(Cpu),
  mem: markRaw(Memory),
  diskIo: markRaw(HardDisk),
  load: markRaw(DashboardOne),
  temp: markRaw(Thermometer),
  swap: markRaw(Switch),
};

const cpuSeries = computed<ChartPoint[]>(() => props.rows.map(d => ({ t: d.ts, v: d.cpu ?? d.cpu_percent ?? 0 })));
const memSeries = computed<ChartPoint[]>(() => props.rows.map(d => ({ t: d.ts, v: d.mem_pct ?? 0 })));
const loadSeries = computed<ChartPoint[]>(() => props.rows.map(d => ({ t: d.ts, v: d.load1 ?? 0 })));
// Windows 无 Unix load（load1 恒 0，图上是一条贴底直线 = "没显示"）：
// 该图对 Windows 节点改画进程总数曲线（与卡片进程胶囊同口径）。
// 过滤无值点：process_count 从 2026-10-12 才开始采集，窗口内更早的点为 null，
// 映射成 0 会画出一段伪造的贴底直线——曲线应从最早有值点开始。
const isWindows = computed(() => (props.agent.os || '').toLowerCase().includes('windows'));
const processSeries = computed<ChartPoint[]>(() =>
  props.rows
    .filter(d => d.process_count != null)
    .map(d => ({ t: d.ts, v: d.process_count as number }))
);

// —— 图表卡右上角当前值（对齐参考面板「标题 + 当前值」卡片风格）——
// 数据取实时 agent（与首页卡片同源）；agent 未加载/字段缺失返回 undefined → 不渲染。
const cpuCurrent = computed(() => formatPercent(props.agent.cpu ?? props.agent.cpu_percent));
const memCurrent = computed(() => formatPercent(props.agent.mem_pct));
const swapCurrent = computed(() => formatPercent(props.agent.swap_pct));
const tempCurrent = computed(() => (props.agent.temp != null ? `${props.agent.temp.toFixed(1)} °C` : undefined));
const diskIoCurrent = computed(
  () => `R ${formatBytes(props.agent.disk_r_rate || 0, 1)}/s · W ${formatBytes(props.agent.disk_w_rate || 0, 1)}/s`
);
const loadCurrent = computed(() => {
  if (isWindows.value) return props.agent.process_count != null ? String(props.agent.process_count) : undefined;
  return props.agent.load1 != null ? props.agent.load1.toFixed(2) : undefined;
});
const diskReadSeries = computed<ChartPoint[]>(() => props.rows.map(d => ({ t: d.ts, v: d.disk_r_rate ?? 0 })));
const diskWriteSeries = computed<ChartPoint[]>(() => props.rows.map(d => ({ t: d.ts, v: d.disk_w_rate ?? 0 })));
const tempSeries = computed<ChartPoint[]>(() => props.rows.map(d => ({ t: d.ts, v: d.temp ?? 0 })));
const swapSeries = computed<ChartPoint[]>(() => props.rows.map(d => ({ t: d.ts, v: d.swap_pct ?? 0 })));
</script>

<template>
  <!-- 六图时间范围切换：只影响 CPU/内存/磁盘IO/负载/温度/swap 的显示范围；
       磁盘耗尽预测固定用 30d 基线，不随此切换变化，避免 ETA 抖动。 -->
  <div class="mb-2 flex flex-wrap items-center gap-2">
    <span class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap">{{ t('node.chart.range') }}</span>
    <button
      v-for="r in CHART_RANGES"
      :key="r"
      type="button"
      @click="$emit('switch-range', r)"
      class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap"
      :class="{ 'is-active': range === r }"
      :disabled="loading"
    >{{ t('node.range.' + r) }}</button>
    <button
      type="button"
      class="glass pill-card inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium leading-5 whitespace-nowrap"
      :class="{ 'is-active': range === 'custom' }"
      :disabled="loading"
      @click="$emit('open-custom')"
    >{{ t('node.range.custom') }}</button>
  </div>

  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
  <ChartLatency :title="t('node.chart.cpu')" :icon="CHART_ICONS.cpu" :data="cpuSeries" color="#38bdf8" :current="cpuCurrent" />
  <ChartLatency :title="t('node.chart.mem')" :icon="CHART_ICONS.mem" :data="memSeries" color="#a78bfa" :current="memCurrent" />
  <ChartLatencyDual
    :title="t('node.chart.diskIo')"
    :icon="CHART_ICONS.diskIo"

    :series="[
      { name: t('node.read'), data: diskReadSeries, color: '#22d3ee' },
      { name: t('node.write'), data: diskWriteSeries, color: '#c084fc' },
    ]"
    :current="diskIoCurrent"
  />
  <ChartLatency
    :title="isWindows ? t('node.chart.process') : t('node.chart.load')"
    :icon="CHART_ICONS.load"

    :data="isWindows ? processSeries : loadSeries"
    color="#fb923c"
    :current="loadCurrent"
  />
  <ChartLatency :title="t('node.chart.temp')" :icon="CHART_ICONS.temp" :data="tempSeries" color="#f87171" :current="tempCurrent" />
  <ChartLatency :title="t('node.chart.swap')" :icon="CHART_ICONS.swap" :data="swapSeries" color="#fbbf24" :current="swapCurrent" />
</div>
</template>
