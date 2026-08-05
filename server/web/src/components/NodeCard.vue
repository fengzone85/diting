<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { Agent } from '../services/types';
import { formatBytes, formatDuration, formatPercent } from '../utils/format';

const props = defineProps<{ agent: Agent }>();

const status = computed(() => {
  if (props.agent.status) return props.agent.status;
  return props.agent.online ? 'online' : 'offline';
});

const statusText = computed(() => ({ online: '在线', offline: '离线', warn: '告警' }[status.value]));
const cpu = computed(() => props.agent.cpu ?? props.agent.cpu_percent);
</script>

<template>
  <RouterLink
    :to="`/node/${agent.id}`"
    class="glass card-hover block p-5 text-slate-200"
  >
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <img v-if="agent.country || agent.country_code" :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`" class="h-5 w-7 rounded-sm" :alt="agent.country" />
        <h3 class="font-semibold text-white">{{ agent.name }}</h3>
      </div>
      <span class="flex items-center gap-2 text-xs">
        <span class="status-dot" :class="`status-${status}`" />
        {{ statusText }}
      </span>
    </div>
    <div class="mt-4 grid grid-cols-2 gap-4 text-sm">
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
  </RouterLink>
</template>
