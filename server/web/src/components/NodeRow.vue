<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { Agent } from '../services/types';
import { formatDuration, formatPercent, formatBitsPerSecond } from '../utils/format';
import { providerAlias, customTag } from '../composables/useApp';

const props = defineProps<{ agent: Agent }>();
const status = computed(() => (props.agent.online ? 'online' : 'offline'));
const cpu = computed(() => props.agent.cpu ?? props.agent.cpu_percent);
const merchantName = computed(() => providerAlias(props.agent.id, props.agent.merchant));
const tag = computed(() => customTag(props.agent.id));
</script>

<template>
  <RouterLink
    :to="`/node/${agent.id}`"
    class="flex items-center gap-4 rounded-lg border border-slate-700/50 bg-slate-800/30 px-4 py-3 text-sm hover:border-sky-500/50 hover:bg-slate-800/50"
  >
    <img
      v-if="agent.country || agent.country_code"
      :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`"
      class="h-5 w-7 rounded-sm"
      :alt="agent.country"
    />
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class="status-dot" :class="`status-${status}`" />
        <span class="font-medium text-content">{{ agent.name }}</span>
        <span class="text-xs text-slate-500">{{ agent.group || agent.grp || '' }}</span>
        <span v-if="merchantName" class="text-xs text-slate-600">{{ merchantName }}</span>
        <span v-if="tag" class="rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] text-sky-300">{{ tag }}</span>
      </div>
      <div class="mt-1 truncate text-xs text-slate-500">
        {{ agent.hostname || '' }}{{ agent.hostname && agent.os ? ' · ' : '' }}{{ agent.os || '' }}
      </div>
    </div>
    <div class="hidden w-20 text-right md:block">
      <span :class="cpu && cpu >= 90 ? 'text-rose-400' : cpu && cpu >= 75 ? 'text-amber-400' : 'text-slate-300'">{{ formatPercent(cpu) }}</span>
    </div>
    <div class="hidden w-20 text-right md:block">
      <span :class="agent.mem_pct && agent.mem_pct >= 90 ? 'text-rose-400' : agent.mem_pct && agent.mem_pct >= 75 ? 'text-amber-400' : 'text-slate-300'">{{ formatPercent(agent.mem_pct) }}</span>
    </div>
    <div class="hidden w-20 text-right lg:block">{{ formatPercent(agent.disk_pct) }}</div>
    <div class="hidden w-28 text-right lg:block">{{ formatDuration(agent.uptime) }}</div>
    <div class="hidden w-40 text-right xl:block">↓{{ formatBitsPerSecond(agent.net_rx_rate) }} ↑{{ formatBitsPerSecond(agent.net_tx_rate) }}</div>
  </RouterLink>
</template>
