<script setup lang="ts">
// F7 在线率 + 磁盘耗尽预测：横排共用一行（仅一张卡时占满）。
import { t } from '../../composables/useI18n';
import { formatBytes, formatDuration, formatPercent } from '../../utils/format';
import type { OnlineHistory } from '../../services/types';

interface DiskPredictDTO {
  eta: string | null;
  pct: number;
  days: number | null;
  total: number;
  used: number;
  stable: boolean;
}

defineProps<{
  online: OnlineHistory | null;
  diskPredict: DiskPredictDTO | null;
}>();

function onlineDayClass(pct: number | null): string {
  if (pct == null) return 'bg-slate-600/40';
  if (pct >= 99) return 'bg-emerald-400/80';
  if (pct >= 95) return 'bg-amber-400/80';
  return 'bg-rose-400/80';
}

function onlineBarHeight(pct: number | null): number {
  // 0% 也保留一条可见的短柱，否则「全绿里夹一天全停」在视觉上会消失
  return pct == null ? 6 : Math.max(8, Math.min(100, pct));
}

function onlinePctClass(pct: number | null): string {
  if (pct == null) return 'text-muted';
  if (pct >= 99) return 'text-emerald-400';
  if (pct >= 95) return 'text-amber-400';
  return 'text-rose-400';
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<template>
  <!-- F7 在线率 + 磁盘耗尽预测：横排共用一行（仅一张卡时占满） -->
  <div v-if="online || diskPredict" class="grid grid-cols-1 gap-6" :class="online && diskPredict ? 'md:grid-cols-2' : ''">
  <div v-if="online" class="glass p-5">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h3 class="flex items-center gap-2 text-base font-semibold text-content">
        <svg class="h-4 w-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
        {{ t('node.onlineTitle') }}
      </h3>
      <span v-if="online.uptime_pct != null" class="text-sm text-muted">
        {{ t('node.online30d') }}
        <span class="ml-1 text-lg font-semibold" :class="onlinePctClass(online.uptime_pct)">{{ online.uptime_pct.toFixed(1) }}%</span>
      </span>
    </div>

    <div class="mb-4 flex h-10 items-end gap-[3px]">
      <div
        v-for="d in online.daily"
        :key="d.date"
        class="group relative flex-1 rounded-sm"
        :class="onlineDayClass(d.pct)"
        :style="{ height: `${onlineBarHeight(d.pct)}%` }"
      >
        <span class="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-2 py-0.5 text-[10px] text-white group-hover:block">
          {{ d.date }} · {{ d.pct == null ? '—' : `${d.pct.toFixed(1)}%` }}
        </span>
      </div>
    </div>

    <div class="text-xs">
      <div class="mb-1 text-muted">{{ t('node.outages') }}</div>
      <div v-if="!online.outages.length" class="text-emerald-400/80">{{ t('node.noOutages') }}</div>
      <div v-else class="space-y-1">
        <div
          v-for="o in online.outages.slice(0, 5)"
          :key="o.started_at"
          class="flex items-center justify-between gap-3 rounded-lg bg-surface/60 px-3 py-1.5"
        >
          <span class="text-secondary">{{ fmtDateTime(o.started_at) }}</span>
          <span :class="o.ended_at == null ? 'text-rose-400' : 'text-muted'">
            {{ o.ended_at == null ? t('node.outageOngoing') : formatDuration(o.duration_sec) }}
          </span>
        </div>
      </div>
    </div>
  </div>

    <div v-if="diskPredict" class="glass p-5">
      <div class="mb-4 flex items-center justify-between">
        <h3 class="flex items-center gap-2 text-base font-semibold text-content">
          <svg class="h-4 w-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>
          {{ t('node.diskEta') }}
        </h3>
        <span
          class="rounded-full px-2.5 py-0.5 text-xs font-medium"
          :class="diskPredict.pct >= 80 ? 'bg-rose-400/15 text-rose-300' : diskPredict.pct >= 50 ? 'bg-amber-400/15 text-amber-300' : 'bg-sky-400/15 text-sky-300'"
        >{{ formatPercent(diskPredict.pct) }}</span>
      </div>
      <!-- 占用率进度条：铺满「已用/总容量」内层胶囊的高度（背景层，半透明实色，宽度=占用率） -->
      <div class="relative mb-4 flex items-baseline justify-between overflow-hidden rounded-xl bg-surface/40 px-4 py-3">
        <div
          class="pointer-events-none absolute inset-y-0 left-0 rounded-xl transition-[width,background-color] duration-300 ease-out"
          :class="diskPredict.pct >= 80 ? 'bg-red-500/28' : diskPredict.pct >= 60 ? 'bg-amber-500/22' : 'bg-emerald-500/18'"
          :style="{ width: Math.min(diskPredict.pct, 100) + '%' }"
        ></div>
        <span class="relative z-10 text-2xl font-bold text-content">{{ formatBytes(diskPredict.used) }}</span>
        <span class="relative z-10 text-sm text-muted">/ {{ formatBytes(diskPredict.total) }}</span>
      </div>
      <div class="flex items-center justify-between rounded-xl bg-surface/60 px-4 py-3">
        <span class="flex items-center gap-2 text-sm text-muted">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          {{ t('node.etaLabel') }}
        </span>
        <span v-if="diskPredict.eta" class="text-sm font-semibold text-sky-300">{{ t('node.etaIn', { eta: diskPredict.eta, days: diskPredict.days ?? 0 }) }}</span>
        <span v-else class="rounded-full bg-emerald-400/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">{{ t('node.growthFlat') }}</span>
      </div>
    </div>
  </div>
</template>
