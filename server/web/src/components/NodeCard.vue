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

function avgProbe(points: unknown) {
  if (!points) return null;
  // 兼容对象格式 {ms, ok, loss}（旧版公开页 API）
  if (typeof points === 'object' && !Array.isArray(points)) {
    const p = points as { ms?: number; ok?: boolean };
    return p.ok !== false && typeof p.ms === 'number' ? p.ms : null;
  }
  // 数组格式 [{ms, ok}]
  const arr = points as { ms: number; ok: boolean }[];
  if (!arr?.length) return null;
  const ok = arr.filter((p) => p.ok !== false);
  if (!ok.length) return null;
  return +(ok.reduce((s, p) => s + p.ms, 0) / ok.length).toFixed(1);
}

function probeTargets() {
  const p = props.agent.probes;
  if (!p) return [];
  if (Array.isArray(p)) return p;
  return Object.entries(p).map(([target, v]) => ({ target, ...(v as Record<string, unknown>) }));
}

// 旧版卡片 pctClass：>90 红色、>70 橙色、正常绿色
function pctClass(v: number | null | undefined) {
  if (v == null) return '';
  if (v >= 90) return 'text-rose-400';
  if (v >= 70) return 'text-amber-400';
  return 'text-emerald-400';
}

const isWindows = computed(() => (props.agent.os || '').toLowerCase().includes('windows'));
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
          <h3 class="font-semibold text-content">{{ agent.name }}</h3>
          <p v-if="template === 'visual' && (agent.group || merchantName)" class="text-xs text-secondary">
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
        <p class="text-secondary">{{ t('card.cpu') }}</p>
        <p class="font-medium">{{ formatPercent(cpu) }}</p>
      </div>
      <div>
        <p class="text-secondary">{{ t('card.memory') }}</p>
        <p class="font-medium">{{ formatBytes(agent.mem_used) }} / {{ formatBytes(agent.mem_total) }}</p>
      </div>
      <div>
        <p class="text-secondary">{{ t('card.disk') }}</p>
        <p class="font-medium">{{ formatBytes(agent.disk_used) }} / {{ formatBytes(agent.disk_total) }}</p>
      </div>
      <div>
        <p class="text-secondary">{{ t('card.uptime') }}</p>
        <p class="font-medium">{{ formatDuration(agent.uptime) }}</p>
      </div>
    </div>

    <div v-else class="mt-4 space-y-2.5 text-xs">
      <!-- 紧凑 6 指标网格：CPU | 内存 | 负载 | 温度 | Swap | IO -->
      <div class="grid grid-cols-3 gap-x-2 gap-y-2 sm:grid-cols-6">
        <div>
          <p class="text-secondary">{{ t('card.cpu') }}</p>
          <p class="mt-0.5 font-medium" :class="pctClass(cpu)">{{ formatPercent(cpu) }}</p>
        </div>
        <div>
          <p class="text-secondary">{{ t('card.memory') }}</p>
          <p class="mt-0.5 font-medium" :class="pctClass(agent.mem_pct)">{{ formatPercent(agent.mem_pct) }}</p>
        </div>
        <div>
          <p class="text-secondary">{{ isWindows ? '进程' : '负载' }}</p>
          <p class="mt-0.5 font-medium">{{ agent.load1 != null ? agent.load1.toFixed(2) : '—' }}</p>
        </div>
        <div>
          <p class="text-secondary">温度</p>
          <p class="mt-0.5 font-medium">{{ agent.temp != null ? agent.temp.toFixed(1) + '°C' : '—' }}</p>
        </div>
        <div>
          <p class="text-secondary">Swap</p>
          <p class="mt-0.5 font-medium" :class="pctClass(agent.swap_pct)">{{ formatPercent(agent.swap_pct) }}</p>
        </div>
        <div>
          <p class="text-secondary">IO MB/s</p>
          <p class="mt-0.5 font-medium">{{ ((agent.disk_r_rate || 0) / 1048576).toFixed(2) }}/{{ ((agent.disk_w_rate || 0) / 1048576).toFixed(2) }}</p>
        </div>
      </div>

      <!-- 网络 + 探针（独立行） -->
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <p class="text-secondary">网络</p>
          <p class="mt-0.5 font-medium">↓ {{ formatBitsPerSecond(agent.net_rx_rate) }} · ↑ {{ formatBitsPerSecond(agent.net_tx_rate) }}</p>
        </div>
        <div v-if="probeTargets().length" class="flex flex-wrap items-center gap-1.5">
          <span class="text-secondary">探针：</span>
          <span
            v-for="pt in probeTargets()"
            :key="pt.target"
            class="rounded-full bg-slate-800 px-2 py-0.5"
            :class="pt.ok !== false && pt.ms != null ? 'text-emerald-400' : 'text-rose-400'"
          >{{ pt.target }} {{ pt.ok !== false && pt.ms != null ? `${formatNumber(pt.ms as number, 1)} ms` : t('card.timeout') }}</span>
        </div>
      </div>

      <!-- 磁盘条 + 月流量 -->
      <div class="space-y-1.5 text-[11px]">
        <div class="flex items-center gap-2">
          <span class="w-8 shrink-0 text-secondary">{{ t('card.disk') }}</span>
          <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-700">
            <div class="h-full rounded-full transition-all" :class="pctClass(agent.disk_pct)" :style="{ width: `${Math.min(agent.disk_pct || 0, 100)}%` }"></div>
          </div>
          <span class="w-32 text-right text-secondary">{{ formatBytes(agent.disk_used) }}/{{ formatBytes(agent.disk_total) }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="w-8 shrink-0 text-secondary">流量</span>
          <span class="text-secondary">{{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) }}</span>
          <span class="ml-auto text-secondary">{{ t('card.uptime') }} {{ formatDuration(agent.uptime) }}</span>
        </div>
      </div>

      <!-- 到期/配额 -->
      <div v-if="agent.expire_at || agent.monthly_quota_gb" class="flex flex-wrap gap-1.5 text-secondary">
        <span v-if="agent.expire_at">
          {{ t('card.expire') }}
          <span
            :class="{
              'text-rose-400': (daysUntil(agent.expire_at) ?? 0) < 0,
              'text-amber-400': (daysUntil(agent.expire_at) ?? 999) <= 7 && (daysUntil(agent.expire_at) ?? 0) >= 0,
            }"
          >{{ agent.expire_at }}</span>
        </span>
        <span v-if="agent.monthly_quota_gb">{{ t('card.quota') }} {{ agent.monthly_quota_gb }} GB</span>
      </div>
    </div>
  </RouterLink>
</template>
