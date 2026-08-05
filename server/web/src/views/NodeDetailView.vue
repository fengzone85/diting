<script setup lang="ts">
import { onMounted, computed } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import AppHeader from '../components/AppHeader.vue';
import AppFooter from '../components/AppFooter.vue';
import StatCard from '../components/ui/StatCard.vue';
import ChartLatency from '../components/ChartLatency.vue';
import { publicApi } from '../services/publicApi';
import { useApp } from '../composables/useApp';
import type { Probes, ChartPoint } from '../services/types';
import { formatBytes, formatBitsPerSecond, formatDuration, formatPercent, formatNumber } from '../utils/format';
import { ref } from 'vue';

const route = useRoute();
const { state } = useApp();
const agentId = computed(() => route.params.id as string);
const probes = ref<Probes>({});
const loading = ref(false);
const error = ref<string | null>(null);

const agent = computed(() => state.agents.find(a => a.id === agentId.value));

const sparkline = computed(() => state.sparklines[agentId.value] || []);
const cpuSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.cpu ?? 0 })));
const memSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.mem_pct ?? 0 })));
const rxSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.net_rx_rate ?? 0 })));
const txSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.net_tx_rate ?? 0 })));

function avgProbe(points: { ts: number; ms: number; ok: boolean; loss: number }[]) {
  if (!points || !points.length) return null;
  const ok = points.filter(p => p.ok);
  if (!ok.length) return null;
  return ok.reduce((s, p) => s + p.ms, 0) / ok.length;
}

function lossPercent(points: { ts: number; ms: number; ok: boolean; loss: number }[]) {
  if (!points || !points.length) return 0;
  return points.filter(p => !p.ok).length / points.length * 100;
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
          <div class="flex flex-wrap items-center gap-3">
            <img v-if="agent.country || agent.country_code" :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`" class="h-6 w-8 rounded-sm" :alt="agent.country" />
            <h1 class="text-2xl font-bold">{{ agent.name }}</h1>
            <span class="status-dot" :class="agent.online ? 'status-online' : 'status-offline'" />
            <span v-if="agent.version" class="ml-auto rounded-full bg-slate-700/50 px-3 py-1 text-xs text-slate-400">v{{ agent.version }}</span>
          </div>
          <p class="mt-2 text-sm text-slate-500">{{ agent.os }} · {{ agent.hostname }} · {{ agent.id }}</p>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="CPU" :value="formatPercent(agent.cpu)" />
          <StatCard label="内存" :value="formatPercent(agent.mem_pct)" :sub="`${formatBytes(agent.mem_used)} / ${formatBytes(agent.mem_total)}`" />
          <StatCard label="磁盘" :value="formatPercent(agent.disk_pct)" :sub="`${formatBytes(agent.disk_used)} / ${formatBytes(agent.disk_total)}`" />
          <StatCard label="运行时间" :value="formatDuration(agent.uptime)" />
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="下载速率" :value="formatBitsPerSecond(agent.net_rx_rate)" />
          <StatCard label="上传速率" :value="formatBitsPerSecond(agent.net_tx_rate)" />
          <StatCard label="月下载" :value="formatBytes(agent.net_rx_month)" />
          <StatCard label="月上传" :value="formatBytes(agent.net_tx_month)" />
        </div>

        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartLatency title="CPU %" :data="cpuSeries" color="#38bdf8" />
          <ChartLatency title="内存 %" :data="memSeries" color="#a78bfa" />
          <ChartLatency title="下载速率 (bps)" :data="rxSeries" color="#4ade80" />
          <ChartLatency title="上传速率 (bps)" :data="txSeries" color="#facc15" />
        </div>

        <div v-if="agent.disks?.length" class="glass p-4">
          <h3 class="mb-3 text-lg font-semibold">磁盘</h3>
          <div class="space-y-2">
            <div v-for="disk in agent.disks" :key="disk.mount" class="flex items-center justify-between rounded-lg bg-slate-800/40 px-4 py-2 text-sm">
              <span class="text-slate-300">{{ disk.mount }}</span>
              <div class="flex items-center gap-4">
                <div class="h-2 w-32 overflow-hidden rounded-full bg-slate-700">
                  <div class="h-full bg-sky-500" :style="{ width: `${Math.min(disk.pct || 0, 100)}%` }" />
                </div>
                <span class="text-slate-400">{{ formatBytes(disk.used) }} / {{ formatBytes(disk.total) }} ({{ formatPercent(disk.pct) }})</span>
              </div>
            </div>
          </div>
        </div>

        <div class="glass p-4">
          <h3 class="mb-3 text-lg font-semibold">网络质量</h3>
          <div class="space-y-2">
            <div v-for="(points, target) in probes" :key="target" class="flex items-center justify-between rounded-lg bg-slate-800/40 px-4 py-2 text-sm">
              <span class="text-slate-300">{{ target }}</span>
              <div class="flex gap-4">
                <span :class="avgProbe(points) != null ? 'text-emerald-400' : 'text-rose-400'">
                  {{ avgProbe(points) != null ? `${avgProbe(points)?.toFixed(1)} ms` : '超时' }}
                </span>
                <span class="text-slate-500">丢包 {{ formatNumber(lossPercent(points), 1) }}%</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
    <AppFooter />
  </div>
</template>
