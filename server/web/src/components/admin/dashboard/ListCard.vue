<script setup lang="ts">
// 列表卡（对齐 Komari 的 expiry 卡）：标题 + 若干「名称 / 数值」行，支持严重度着色
import type { Component } from 'vue';
import { Calendar } from '@icon-park/vue-next';
import WidgetShell from './WidgetShell.vue';
import { useI18n } from '../../../composables/useI18n';

interface ListRow {
  key: string;
  label: string;
  value: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
}

withDefaults(defineProps<{
  title: string;
  icon?: Component;
  rows: ListRow[];
  empty?: string;
}>(), { icon: Calendar });

const { t } = useI18n();

const toneClass: Record<string, string> = {
  default: 'text-slate-300',
  warning: 'text-amber-300',
  danger: 'text-rose-300',
  success: 'text-emerald-400',
};
</script>

<template>
  <WidgetShell :title="title" :icon="icon">
    <div v-if="!rows.length" class="text-xs text-slate-500">{{ empty || t('dashboard.noData') }}</div>
    <div v-else class="space-y-1.5">
      <div
        v-for="r in rows"
        :key="r.key"
        class="flex items-center justify-between gap-2 border-b border-slate-700/40 pb-1.5 text-xs last:border-0"
      >
        <span class="truncate text-slate-300" :title="r.label">{{ r.label }}</span>
        <span class="shrink-0 font-medium tabular-nums" :class="toneClass[r.tone || 'default']">{{ r.value }}</span>
      </div>
    </div>
  </WidgetShell>
</template>
