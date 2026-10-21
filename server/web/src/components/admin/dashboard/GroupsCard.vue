<script setup lang="ts">
// 分组概览卡（对齐 Komari 的分组/地区概览）：各分组在线数 / 总数 + 在线率条
import { Data } from '@icon-park/vue-next';
import WidgetShell from './WidgetShell.vue';
import { useI18n } from '../../../composables/useI18n';

defineProps<{
  title: string;
  rows: { name: string; total: number; online: number }[];
}>();

const { t } = useI18n();
</script>

<template>
  <WidgetShell :title="title" :icon="Data">
    <div v-if="!rows.length" class="text-xs text-slate-500">{{ t('dashboard.noData') }}</div>
    <div v-else class="space-y-2">
      <div v-for="g in rows" :key="g.name" class="space-y-1">
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="truncate text-slate-300" :title="g.name">{{ g.name }}</span>
          <span class="shrink-0 tabular-nums text-slate-400">
            <span :class="g.online < g.total ? 'text-amber-300' : 'text-emerald-400'">{{ g.online }}</span>
            / {{ g.total }}
          </span>
        </div>
        <div class="h-1.5 overflow-hidden rounded bg-slate-700/60">
          <div
            class="h-full rounded bg-sky-500"
            :style="{ width: `${g.total > 0 ? Math.round((g.online / g.total) * 100) : 0}%` }"
          ></div>
        </div>
      </div>
    </div>
  </WidgetShell>
</template>
