<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { Agent } from '../services/types';
import { formatBytes, formatDuration, formatPercent, formatBitsPerSecond, formatNumber } from '../utils/format';
import { providerAlias } from '../composables/useApp';
import { useI18n } from '../composables/useI18n';

const { t } = useI18n();

const props = defineProps<{
  agent: Agent;
  template?: 'simple' | 'visual';
  draggable?: boolean;
  size?: 'mini' | 'compact' | 'comfortable' | 'large';
  tag?: string;
}>();

const emit = defineEmits<{
  (e: 'dragstart', event: DragEvent): void;
  (e: 'dragend', event: DragEvent): void;
}>();

const status = computed(() => {
  if (props.agent.status) return props.agent.status;
  return props.agent.online ? 'online' : 'offline';
});

const statusText = computed(() => {
  const map: Record<string, string> = {
    online: t('card.online'),
    offline: t('card.offline'),
    warn: t('card.warn'),
  };
  return map[status.value];
});
const cpu = computed(() => props.agent.cpu ?? props.agent.cpu_percent);
const merchantName = computed(() => providerAlias(props.agent.id, props.agent.merchant));
const padClass = computed(() => {
  const s = props.size || 'comfortable';
  return {
    mini: 'p-3',
    compact: 'p-3.5',
    comfortable: 'p-5',
    large: 'p-6',
  }[s];
});

function daysUntil(dateStr?: string) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

function avgProbe(points: { ts: number; ms: number; ok: boolean; loss: number }[]) {
  if (!points?.length) return null;
  const ok = points.filter((p) => p.ok);
  if (!ok.length) return null;
  return ok.reduce((s, p) => s + p.ms, 0) / ok.length;
}
</script>

<template>
  <RouterLink
    :to="`/node/${agent.id}`"
    class="glass card-hover block text-slate-200"
    :class="[template === 'simple' ? 'p-4' : padClass, size === 'mini' ? 'text-xs' : '']"
    :draggable="draggable"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend', $event)"
  >
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <img
          v-if="agent.country || agent.country_code"
          :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`"
          class="h-5 w-7 rounded-sm"
          :alt="agent.country"
        />
        <div>
          <h3 class="font-semibold text-white">{{ agent.name }}</h3>
          <p v-if="template === 'visual' && (agent.group || merchantName)" class="text-xs text-slate-500">
            {{ agent.group || '' }}{{ agent.group && merchantName ? ' · ' : '' }}{{ merchantName || '' }}
          </p>
        </div>
      </div>
      <div class="flex flex-col items-end gap-1">
        <span class="flex items-center gap-2 text-xs">
          <span class="status-dot" :class="`status-${status}`" />
          {{ statusText }}
        </span>
        <span v-if="agent.version" class="text-[10px] text-slate-600">v{{ agent.version }}</span>
      </div>
    </div>

    <span
      v-if="tag"
      class="mt-2 inline-block rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] text-sky-300"
    >{{ tag }}</span>

    <div v-if="template === 'simple'" class="mt-4 grid grid-cols-2 gap-4 text-sm">
      <div>
        <p class="text-slate-500">{{ t('card.cpu') }}</p>
        <p class="font-medium">{{ formatPercent(cpu) }}</p>
      </div>
      <div>
        <p class="text-slate-500">{{ t('card.memory') }}</p>
        <p class="font-medium">{{ formatBytes(agent.mem_used) }} / {{ formatBytes(agent.mem_total) }}</p>
      </div>
      <div>
        <p class="text-slate-500">{{ t('card.disk') }}</p>
        <p class="font-medium">{{ formatBytes(agent.disk_used) }} / {{ formatBytes(agent.disk_total) }}</p>
      </div>
      <div>
        <p class="text-slate-500">{{ t('card.uptime') }}</p>
        <p class="font-medium">{{ formatDuration(agent.uptime) }}</p>
      </div>
    </div>

    <div v-else class="mt-4 space-y-3 text-sm">
      <div class="grid grid-cols-3 gap-3">
        <div>
          <p class="text-slate-500">{{ t('card.cpu') }}</p>
          <p class="font-medium">{{ formatPercent(cpu) }}</p>
        </div>
        <div>
          <p class="text-slate-500">{{ t('card.memory') }}</p>
          <p class="font-medium">{{ formatPercent(agent.mem_pct) }}</p>
        </div>
        <div>
          <p class="text-slate-500">{{ t('card.disk') }}</p>
          <p class="font-medium">{{ formatPercent(agent.disk_pct) }}</p>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3 text-xs">
        <div>
          <p class="text-slate-500">↓ {{ formatBitsPerSecond(agent.net_rx_rate) }}</p>
          <p class="text-slate-500">↑ {{ formatBitsPerSecond(agent.net_tx_rate) }}</p>
        </div>
        <div>
          <p class="text-slate-500">{{ t('card.monthlyTraffic') }} {{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) }}</p>
          <p class="text-slate-500">{{ t('card.uptime') }} {{ formatDuration(agent.uptime) }}</p>
        </div>
      </div>
      <div v-if="agent.probes && Object.keys(agent.probes).length" class="flex flex-wrap gap-2 text-xs">
        <span
          v-for="(points, target) in agent.probes"
          :key="target"
          class="rounded-full bg-slate-800 px-2 py-0.5"
          :class="avgProbe(points) != null ? 'text-emerald-400' : 'text-rose-400'"
        >
          {{ target }} {{ avgProbe(points) != null ? `${formatNumber(avgProbe(points)!, 1)} ms` : t('card.timeout') }}
        </span>
      </div>
      <div v-if="agent.expire_at || agent.monthly_quota_gb || tag" class="flex flex-wrap gap-3 text-xs text-slate-500">
        <span v-if="agent.expire_at">
          {{ t('card.expire') }}
          <span
            :class="{
              'text-rose-400': (daysUntil(agent.expire_at) ?? 0) < 0,
              'text-amber-400': (daysUntil(agent.expire_at) ?? 999) <= 7 && (daysUntil(agent.expire_at) ?? 0) >= 0,
            }"
          >
            {{ agent.expire_at }}
          </span>
        </span>
        <span v-if="agent.monthly_quota_gb">{{ t('card.quota') }} {{ agent.monthly_quota_gb }} GB</span>
      </div>
    </div>
  </RouterLink>
</template>
