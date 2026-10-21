<script setup lang="ts">
// 排行卡（对齐 Komari 的 CPU / 内存 / 磁盘排行卡）：名称 + 数值 + 进度条 + 明细
import type { Component } from 'vue';
import { ChartLine } from '@icon-park/vue-next';
import WidgetShell from './WidgetShell.vue';
import { useI18n } from '../../../composables/useI18n';

interface RankRow {
  name: string;
  /** 0-100，用于进度条与配色 */
  pct: number;
  /** 右上角展示文本 */
  value: string;
  /** 进度条下方补充说明（如 已用 / 总量） */
  sub?: string;
}

const props = withDefaults(defineProps<{
  title: string;
  icon?: Component;
  rows: RankRow[];
  warnAt?: number;
  dangerAt?: number;
}>(), { icon: ChartLine, warnAt: 75, dangerAt: 90 });

const { t } = useI18n();

function tone(pct: number) {
  if (pct >= props.dangerAt) return 'text-rose-300';
  if (pct >= props.warnAt) return 'text-amber-300';
  return 'text-slate-200';
}
function bar(pct: number) {
  if (pct >= props.dangerAt) return 'bg-rose-500';
  if (pct >= props.warnAt) return 'bg-amber-500';
  return 'bg-sky-500';
}
</script>

<template>
  <WidgetShell :title="title" :icon="icon">
    <div v-if="!rows.length" class="text-xs text-slate-500">{{ t('dashboard.noData') }}</div>
    <div v-else class="space-y-2.5">
      <div v-for="r in rows" :key="r.name" class="space-y-1">
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="truncate text-slate-300" :title="r.name">{{ r.name }}</span>
          <span class="shrink-0 font-semibold tabular-nums" :class="tone(r.pct)">{{ r.value }}</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded bg-slate-700/60">
          <div class="h-full rounded" :class="bar(r.pct)" :style="{ width: `${Math.min(100, Math.max(0, r.pct))}%` }"></div>
        </div>
        <p v-if="r.sub" class="text-[11px] text-slate-500">{{ r.sub }}</p>
      </div>
    </div>
  </WidgetShell>
</template>
