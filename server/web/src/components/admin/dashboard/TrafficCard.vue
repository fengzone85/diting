<script setup lang="ts">
// 流量概览卡（对齐 Komari 的 traffic 卡）：本月上下行 + 实时速率 + 月配额使用率
import { Speed } from '@icon-park/vue-next';
import WidgetShell from './WidgetShell.vue';
import { useI18n } from '../../../composables/useI18n';

defineProps<{
  title: string;
  /** 已格式化文本 */
  rxMonth: string;
  txMonth: string;
  rxRate: string;
  txRate: string;
  /** 配额使用率（0-100）；无配额时传 null */
  quotaPct: number | null;
  quotaText?: string;
}>();

const { t } = useI18n();

function quotaBar(pct: number) {
  if (pct >= 90) return 'bg-rose-500';
  if (pct >= 75) return 'bg-amber-500';
  return 'bg-sky-500';
}
</script>

<template>
  <WidgetShell :title="title" :icon="Speed">
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2 border-b border-slate-700/40 pb-1.5 text-xs">
        <span class="text-slate-400">↓ {{ t('dashboard.monthRx') }}</span>
        <span class="font-semibold tabular-nums text-slate-200">{{ rxMonth }}</span>
      </div>
      <div class="flex items-center justify-between gap-2 border-b border-slate-700/40 pb-1.5 text-xs">
        <span class="text-slate-400">↑ {{ t('dashboard.monthTx') }}</span>
        <span class="font-semibold tabular-nums text-slate-200">{{ txMonth }}</span>
      </div>
      <div class="flex items-center justify-between gap-2 border-b border-slate-700/40 pb-1.5 text-xs">
        <span class="text-slate-400">{{ t('dashboard.liveRate') }}</span>
        <span class="font-semibold tabular-nums text-slate-200">{{ rxRate }} / {{ txRate }}</span>
      </div>
      <div v-if="quotaPct != null" class="space-y-1 pt-0.5">
        <div class="flex items-center justify-between gap-2 text-[11px] text-slate-400">
          <span>{{ t('dashboard.quotaUsage') }}</span>
          <span class="tabular-nums text-slate-300">{{ quotaPct.toFixed(1) }}%</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded bg-slate-700/60">
          <div class="h-full rounded" :class="quotaBar(quotaPct)" :style="{ width: `${Math.min(100, Math.max(0, quotaPct))}%` }"></div>
        </div>
        <p v-if="quotaText" class="text-[11px] text-slate-500">{{ quotaText }}</p>
      </div>
      <p v-else class="pt-0.5 text-[11px] text-slate-500">{{ t('dashboard.noQuota') }}</p>
    </div>
  </WidgetShell>
</template>
