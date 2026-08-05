<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import AppHeader from '../components/AppHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import StatCard from '../components/ui/StatCard.vue';
import ChartLatency from '../components/ChartLatency.vue';
import { publicApi } from '../services/publicApi';
import { useApp } from '../composables/useApp';
import type { Probes, SparklinePoint, ProbePoint } from '../services/types';
import { formatBytes, formatDuration, formatPercent } from '../utils/format';

const route = useRoute();
const { state } = useApp();
const agentId = computed(() => route.params.id as string);

const probes = ref<Probes>({});
const loading = ref(false);
const error = ref<string | null>(null);

const agent = computed(() => state.agents.find(a => a.id === agentId.value));

const sparkline = computed<SparklinePoint[]>(() => state.sparklines[agentId.value] || []);
const cpuSeries = computed(() => sparkline.value.map(d => ({ t: d.ts, v: d.cpu ?? 0 })));
const memSeries = computed(() => sparkline.value.map(d => ({ t: d.ts, v: d.mem_pct ?? 0 })));

function avgProbe(points: ProbePoint[]) {
  if (!points || !points.length) return null;
  const ok = points.filter(p => p.ok);
  if (!ok.length) return null;
  return ok.reduce((s, p) => s + p.ms, 0) / ok.length;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    probes.value = await publicApi.probes(agentId.value);
  } catch (e) {
    error.value = (e as Error).message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="min-h-screen">
    <AppHeader />
    <main class="mx-auto max-w-7xl px-6">
      <RouterLink to="/" class="mb-4 inline-block text-sm text-sky-400 hover:text-sky-300">← 返回首页</RouterLink>
      <div v-if="error" class="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">
        {{ error }}
      </div>
      <div v-if="agent" class="space-y-6">
        <div class="glass p-6">
          <div class="flex items-center gap-3">
            <img v-if="agent.country || agent.country_code" :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`" class="h-6 w-8 rounded-sm" :alt="agent.country" />
            <h1 class="text-2xl font-bold">{{ agent.name }}</h1>
            <span class="status-dot" :class="agent.online ? 'status-online' : 'status-offline'" />
          </div>
          <p class="mt-1 text-sm text-slate-500">{{ agent.os }} · {{ agent.hostname }}</p>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="CPU" :value="formatPercent(agent.cpu ?? agent.cpu_percent)" />
          <StatCard label="内存" :value="formatPercent(agent.mem_pct)" :sub="`${formatBytes(agent.mem_used)} / ${formatBytes(agent.mem_total)}`" />
          <StatCard label="磁盘" :value="formatPercent(agent.disk_pct)" :sub="`${formatBytes(agent.disk_used)} / ${formatBytes(agent.disk_total)}`" />
          <StatCard label="运行时间" :value="formatDuration(agent.uptime)" />
        </div>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartLatency title="CPU %" :data="cpuSeries" color="#38bdf8" />
          <ChartLatency title="内存 %" :data="memSeries" color="#a78bfa" />
        </div>
        <div class="glass p-4">
          <h3 class="mb-3 text-lg font-semibold">网络质量</h3>
          <div class="space-y-2">
            <div v-for="(points, target) in probes" :key="target" class="flex items-center justify-between rounded-lg bg-slate-800/40 px-4 py-2 text-sm">
              <span class="text-slate-300">{{ target }}</span>
              <span :class="avgProbe(points) != null ? 'text-emerald-400' : 'text-rose-400'">
                {{ avgProbe(points) != null ? `${avgProbe(points)?.toFixed(1)} ms` : '超时' }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </main>
    <AppFooter />
  </div>
</template>
