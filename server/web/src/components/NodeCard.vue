<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { Agent } from '../services/types';
import { formatBytes, formatDuration, formatPercent, formatBitsPerSecond, formatNumber } from '../utils/format';

const props = defineProps<{
  agent: Agent;
  template?: 'simple' | 'visual';
  draggable?: boolean;
}>();

const emit = defineEmits<{
  (e: 'dragstart', event: DragEvent): void;
  (e: 'dragend', event: DragEvent): void;
}>();

const status = computed(() => {
  if (props.agent.status) return props.agent.status;
  return props.agent.online ? 'online' : 'offline';
});

const statusText = computed(() => ({ online: '在线', offline: '离线', warn: '告警' }[status.value]));
const cpu = computed(() => props.agent.cpu ?? props.agent.cpu_percent);

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
    :class="template === 'simple' ? 'p-4' : 'p-5'"
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
          <p v-if="template === 'visual' && (agent.group || agent.merchant)" class="text-xs text-slate-500">
            {{ agent.group || '' }}{{ agent.group && agent.merchant ? ' · ' : '' }}{{ agent.merchant || '' }}
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

    <div v-if="template === 'simple'" class="mt-4 grid grid-cols-2 gap-4 text-sm">
      <div>
        <p class="text-slate-500">CPU</p>
        <p class="font-medium">{{ formatPercent(cpu) }}</p>
      </div>
      <div>
        <p class="text-slate-500">内存</p>
        <p class="font-medium">{{ formatBytes(agent.mem_used) }} / {{ formatBytes(agent.mem_total) }}</p>
      </div>
      <div>
        <p class="text-slate-500">磁盘</p>
        <p class="font-medium">{{ formatBytes(agent.disk_used) }} / {{ formatBytes(agent.disk_total) }}</p>
      </div>
      <div>
        <p class="text-slate-500">运行时间</p>
        <p class="font-medium">{{ formatDuration(agent.uptime) }}</p>
      </div>
    </div>

    <div v-else class="mt-4 space-y-3 text-sm">
      <div class="grid grid-cols-3 gap-3">
        <div>
          <p class="text-slate-500">CPU</p>
          <p class="font-medium">{{ formatPercent(cpu) }}</p>
        </div>
        <div>
          <p class="text-slate-500">内存</p>
          <p class="font-medium">{{ formatPercent(agent.mem_pct) }}</p>
        </div>
        <div>
          <p class="text-slate-500">磁盘</p>
          <p class="font-medium">{{ formatPercent(agent.disk_pct) }}</p>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3 text-xs">
        <div>
          <p class="text-slate-500">↓ {{ formatBitsPerSecond(agent.net_rx_rate) }}</p>
          <p class="text-slate-500">↑ {{ formatBitsPerSecond(agent.net_tx_rate) }}</p>
        </div>
        <div>
          <p class="text-slate-500">月流量 {{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) }}</p>
          <p class="text-slate-500">运行时间 {{ formatDuration(agent.uptime) }}</p>
        </div>
      </div>
      <div v-if="agent.probes && Object.keys(agent.probes).length" class="flex flex-wrap gap-2 text-xs">
        <span
          v-for="(points, target) in agent.probes"
          :key="target"
          class="rounded-full bg-slate-800 px-2 py-0.5"
          :class="avgProbe(points) != null ? 'text-emerald-400' : 'text-rose-400'"
        >
          {{ target }} {{ avgProbe(points) != null ? `${formatNumber(avgProbe(points)!, 1)} ms` : '超时' }}
        </span>
      </div>
      <div v-if="agent.expire_at || agent.monthly_quota_gb" class="flex gap-3 text-xs text-slate-500">
        <span v-if="agent.expire_at">
          到期
          <span
            :class="{
              'text-rose-400': (daysUntil(agent.expire_at) ?? 0) < 0,
              'text-amber-400': (daysUntil(agent.expire_at) ?? 999) <= 7 && (daysUntil(agent.expire_at) ?? 0) >= 0,
            }"
          >
            {{ agent.expire_at }}
          </span>
        </span>
        <span v-if="agent.monthly_quota_gb">配额 {{ agent.monthly_quota_gb }} GB</span>
      </div>
    </div>
  </RouterLink>
</template>
