<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useAdmin } from '../../composables/useAdmin';
import { formatBytes, formatDuration, formatPercent } from '../../utils/format';

const route = useRoute();
const { state } = useAdmin();
const id = computed(() => route.params.id as string);
const agent = computed(() => state.agents.find(a => a.id === id.value));
</script>

<template>
  <div>
    <h1 class="mb-6 text-2xl font-bold">受控端详情</h1>
    <div v-if="agent" class="glass p-6">
      <p class="text-lg font-semibold">{{ agent.name }}</p>
      <p class="text-sm text-slate-500">{{ agent.id }}</p>
      <div class="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>CPU: {{ formatPercent(agent.cpu_percent) }}</div>
        <div>内存: {{ formatBytes(agent.mem_used) }} / {{ formatBytes(agent.mem_total) }}</div>
        <div>磁盘: {{ formatBytes(agent.disk_used) }} / {{ formatBytes(agent.disk_total) }}</div>
        <div>运行时间: {{ formatDuration(agent.uptime) }}</div>
      </div>
    </div>
    <div v-else class="glass p-6 text-slate-500">未找到该受控端</div>
  </div>
</template>
