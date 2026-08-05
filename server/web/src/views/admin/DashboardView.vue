<script setup lang="ts">
import { computed } from 'vue';
import StatCard from '../../components/ui/StatCard.vue';
import { useAdmin } from '../../composables/useAdmin';
import { useApp } from '../../composables/useApp';
import { formatDuration, formatPercent } from '../../utils/format';

const admin = useAdmin();
const app = useApp();

const offlineAgents = computed(() => admin.state.agents.filter(a => !a.latest?.cpu && a.last_seen));
const avgCpu = computed(() => {
  const vals = admin.state.agents.map(a => a.latest?.cpu).filter((v): v is number => v != null);
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : undefined;
});
const avgMem = computed(() => {
  const vals = admin.state.agents.map(a => a.latest?.mem_pct).filter((v): v is number => v != null);
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : undefined;
});
</script>

<template>
  <div>
    <h1 class="mb-6 text-2xl font-bold">总览</h1>
    <div v-if="admin.state.error" class="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">
      {{ admin.state.error }}
    </div>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="受控端总数" :value="(admin.state.overview?.total as number) ?? '-'" />
      <StatCard label="在线" :value="(admin.state.overview?.online as number) ?? '-'" variant="success" />
      <StatCard label="离线" :value="(admin.state.overview?.offline as number) ?? '-'" variant="danger" />
      <StatCard label="告警规则" :value="admin.state.alerts.length" variant="warning" />
    </div>
    <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="平均 CPU" :value="formatPercent(avgCpu)" />
      <StatCard label="平均内存" :value="formatPercent(avgMem)" />
      <StatCard label="公开页" :value="app.state.meta?.public_enabled ? '开启' : '关闭'" />
      <StatCard label="主题" :value="app.state.meta?.public_theme || 'default'" />
    </div>
    <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div class="glass p-4">
        <h2 class="mb-4 text-lg font-semibold">最近离线</h2>
        <div v-if="!offlineAgents.length" class="text-sm text-slate-500">暂无离线受控端</div>
        <div class="space-y-2">
          <div v-for="a in offlineAgents" :key="a.id" class="flex items-center justify-between rounded-lg bg-slate-800/40 px-4 py-2 text-sm">
            <span class="text-slate-300">{{ a.name }}</span>
            <span class="text-slate-500">{{ formatDuration(Math.floor(Date.now() / 1000) - (a.last_seen || 0)) }} 前</span>
          </div>
        </div>
      </div>
      <div class="glass p-4">
        <h2 class="mb-4 text-lg font-semibold">资源占用 Top3</h2>
        <div class="space-y-2">
          <div v-for="a in admin.state.agents.slice().sort((x, y) => (y.latest?.cpu || 0) - (x.latest?.cpu || 0)).slice(0, 3)" :key="a.id" class="flex items-center justify-between rounded-lg bg-slate-800/40 px-4 py-2 text-sm">
            <span class="text-slate-300">{{ a.name }}</span>
            <span class="text-sky-400">CPU {{ formatPercent(a.latest?.cpu) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
