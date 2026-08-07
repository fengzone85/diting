<script setup lang="ts">
import { onMounted, computed, watch, ref, nextTick } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import AppHeader from '../components/AppHeader.vue';
import StatCard from '../components/ui/StatCard.vue';
import ChartLatency from '../components/ChartLatency.vue';
import ChartLatencyMulti from '../components/ChartLatencyMulti.vue';
import ChartLatencyDual from '../components/ChartLatencyDual.vue';
import Loading from '../components/ui/Loading.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import ErrorMessage from '../components/ui/ErrorMessage.vue';
import { publicApi } from '../services/publicApi';
import { useApp } from '../composables/useApp';
import { t } from '../composables/useI18n';
import type { Probes, ChartPoint } from '../services/types';
import { formatBytes, formatBitsPerSecond, formatDuration, formatPercent, formatNumber } from '../utils/format';

function formatDate(s: string | undefined): string {
  if (!s) return '—';
  return s;
}

const route = useRoute();
const { state, visibleAgents } = useApp();
const agentId = computed(() => route.params.id as string);
const probes = ref<Probes>({});
const loading = ref(false);
const error = ref<string | null>(null);

// 网络质量波形图时间范围：后端 RANGES 支持 1h/6h/24h/7d/30d
const RANGES = ['1h', '6h', '24h', '7d', '30d'];
const currentRange = ref('1h');

const agent = computed(() => state.agents.find(a => a.id === agentId.value));

const neighborIds = computed(() => {
  const list = visibleAgents.value.length ? visibleAgents.value : state.agents;
  const idx = list.findIndex(a => a.id === agentId.value);
  if (idx < 0) return { prev: null, next: null };
  return {
    prev: idx > 0 ? list[idx - 1] : null,
    next: idx < list.length - 1 ? list[idx + 1] : null,
  };
});

const sparkline = computed(() => state.sparklines[agentId.value] || []);
const cpuSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.cpu ?? d.cpu_percent ?? 0 })));
const memSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.mem_pct ?? 0 })));
const rxSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.net_rx_rate ?? 0 })));
const txSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.net_tx_rate ?? 0 })));
const loadSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.load1 ?? 0 })));
const diskReadSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.disk_r_rate ?? 0 })));
const diskWriteSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.disk_w_rate ?? 0 })));
const tempSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.temp ?? 0 })));
const swapSeries = computed<ChartPoint[]>(() => sparkline.value.map(d => ({ t: d.ts, v: d.swap_pct ?? 0 })));

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

function p95Probe(points: { ts: number; ms: number; ok: boolean; loss: number }[]) {
  const ok = (points || []).filter(p => p.ok).map(p => p.ms).sort((a, b) => a - b);
  if (!ok.length) return null;
  const idx = Math.min(ok.length - 1, Math.ceil(ok.length * 0.95) - 1);
  return ok[Math.max(0, idx)];
}

function probeSeries(points: { ts: number; ms: number; ok: boolean; loss: number }[]): ChartPoint[] {
  if (!points) return [];
  return points
    .filter(p => p.ok)
    .map(p => ({ t: p.ts * 1000, v: p.ms }))
    .sort((a, b) => a.t - b.t);
}

const PALETTE = ['#f472b6', '#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185'];

const probeSeriesList = computed(() =>
  Object.entries(probes.value).map(([target, points], i) => ({
    name: target,
    color: PALETTE[i % PALETTE.length],
    data: probeSeries(points),
  }))
);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    probes.value = await publicApi.probes(agentId.value, currentRange.value);
  } catch (e) {
    error.value = (e as Error).message || t('common.error');
  } finally {
    loading.value = false;
  }
}

async function switchRange(range: string) {
  if (range === currentRange.value) return;
  currentRange.value = range;
  await load();
}

// 分区 Tab（对齐 komari 分区 概览/负载/延迟）
const detailTab = ref<'overview' | 'load' | 'latency'>('overview');

// 磁盘耗尽预测：基于最近 sparkline 的日增量线性外推（对齐 komari 磁盘耗尽预测）
const diskPredict = computed(() => {
  const sl = sparkline.value;
  if (!sl.length || !agent.value?.disks?.length) return [];
  const dayMs = 86400000;
  const first = sl[0], last = sl[sl.length - 1];
  const spanDays = Math.max((last.ts - first.ts) / dayMs, 0.01);
  return agent.value.disks.map((d) => {
    // 用净使用趋势估算：取当前 pct，按区间增长斜率外推到 100%
    const growthPct = (d.pct ?? 0) - 0; // 无历史 pct 序列时退化为静态
    const dailyGrowth = growthPct / spanDays / 100 * d.total;
    if (dailyGrowth <= 0) return { mount: d.mount, eta: null as string | null, pct: d.pct };
    const remain = d.total * (1 - (d.pct ?? 0) / 100);
    const days = remain / dailyGrowth;
    const eta = new Date(Date.now() + days * dayMs);
    return { mount: d.mount, eta: eta.toISOString().slice(0, 10), pct: d.pct, days: Math.floor(days) };
  });
});

onMounted(load);

// 切换分区 Tab 时，延迟图若由隐藏变显示需 resize 铺满
const latencyChart = ref<InstanceType<typeof ChartLatencyMulti> | null>(null);
watch(detailTab, (tab) => { if (tab === 'latency') nextTick(() => latencyChart.value?.resize()); });
</script>

<template>
  <div class="min-h-screen">
    <AppHeader :meta="state.meta" />
    <main class="mx-auto max-w-7xl px-6 pt-4">
      <div class="mb-4 flex items-center gap-3">
        <RouterLink to="/" class="text-sm text-sky-400 hover:text-sky-300">← {{ t('node.backHome') }}</RouterLink>
        <RouterLink
          v-if="neighborIds.prev"
          :to="`/node/${neighborIds.prev.id}`"
          class="text-sm text-muted hover:text-sky-300"
        >← {{ neighborIds.prev.name }}</RouterLink>
        <RouterLink
          v-if="neighborIds.next"
          :to="`/node/${neighborIds.next.id}`"
          class="ml-auto text-sm text-muted hover:text-sky-300"
        >{{ neighborIds.next.name }} →</RouterLink>
      </div>
      <ErrorMessage v-if="error" class="mb-6" :message="error" />
      <Loading v-if="loading && !agent" />
      <EmptyState v-else-if="!agent" />
      <div v-else class="space-y-6">
        <div class="glass p-6">
          <div class="flex flex-wrap items-center gap-3">
            <img v-if="agent.country || agent.country_code" :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`" class="h-6 w-8 rounded-sm" :alt="agent.country" />
            <h1 class="text-2xl font-bold">{{ agent.name }}</h1>
            <span class="status-dot" :class="agent.online ? 'status-online' : 'status-offline'" />
            <span v-if="agent.version" class="ml-auto rounded-full bg-surface px-3 py-1 text-xs text-muted">v{{ agent.version }}</span>
          </div>
          <p class="mt-2 text-sm text-muted">{{ agent.os }} · {{ agent.hostname }} · {{ agent.id }}</p>
        </div>

        <!-- 分区 Tab（对齐 komari 概览/负载/延迟分区） -->
        <div class="flex flex-wrap gap-2">
          <button
            v-for="tab in ['overview', 'load', 'latency']"
            :key="tab"
            class="rounded-lg border px-3 py-1.5 text-sm"
            :class="detailTab === tab ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
            @click="detailTab = tab as any"
          >{{ t('node.tab.' + tab) }}</button>
        </div>

        <div class="glass p-4">
          <h3 class="mb-3 text-lg font-semibold">{{ t('node.sysInfo') }}</h3>
          <div class="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div class="flex justify-between gap-4 border-b border-divider py-1">
              <span class="text-muted">{{ t('node.hostname') }}</span><span class="text-content">{{ agent.hostname || '—' }}</span>
            </div>
            <div class="flex justify-between gap-4 border-b border-divider py-1">
              <span class="text-muted">{{ t('node.os') }}</span><span class="text-content">{{ agent.os || '—' }}</span>
            </div>
            <div class="flex justify-between gap-4 border-b border-divider py-1">
              <span class="text-muted">{{ t('node.agentVersion') }}</span><span class="text-content">{{ agent.version || '—' }}</span>
            </div>
            <div class="flex justify-between gap-4 border-b border-divider py-1">
              <span class="text-muted">{{ t('node.status') }}</span>
              <span :class="agent.online ? 'text-emerald-400' : 'text-rose-400'">{{ agent.online ? t('common.online') : t('common.offline') }}</span>
            </div>
            <div class="flex justify-between gap-4 border-b border-divider py-1">
              <span class="text-muted">{{ t('node.agentId') }}</span><span class="text-content">{{ agent.id }}</span>
            </div>
          </div>
        </div>

        <div v-show="detailTab === 'overview' || detailTab === 'load'" class="space-y-6">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard :label="t('public.cpu')" :value="formatPercent(agent.cpu)" />
          <StatCard :label="t('public.memory')" :value="formatPercent(agent.mem_pct)" :sub="`${formatBytes(agent.mem_used)} / ${formatBytes(agent.mem_total)}`" />
          <StatCard :label="t('public.disk')" :value="formatPercent(agent.disk_pct)" :sub="`${formatBytes(agent.disk_used)} / ${formatBytes(agent.disk_total)}`" />
          <StatCard :label="t('public.uptime')" :value="formatDuration(agent.uptime)" />
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard :label="t('node.downRate')" :value="formatBitsPerSecond(agent.net_rx_rate)" />
          <StatCard :label="t('node.upRate')" :value="formatBitsPerSecond(agent.net_tx_rate)" />
          <StatCard :label="t('public.rxMonth')" :value="formatBytes(agent.net_rx_month)" />
          <StatCard :label="t('public.txMonth')" :value="formatBytes(agent.net_tx_month)" />
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard :label="t('node.load1')" :value="formatNumber(agent.load1)" />
          <StatCard :label="t('node.temp')" :value="agent.temp != null ? `${formatNumber(agent.temp, 1)}°C` : '—'" />
          <StatCard :label="t('node.swap')" :value="formatPercent(agent.swap_pct)" />
        </div>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <ChartLatency :title="t('node.chart.cpu')" :data="cpuSeries" color="#38bdf8" />
          <ChartLatency :title="t('node.chart.mem')" :data="memSeries" color="#a78bfa" />
          <ChartLatencyDual
            :title="t('node.chart.net')"
            :series="[
              { name: t('node.down'), data: rxSeries, color: '#4ade80' },
              { name: t('node.up'), data: txSeries, color: '#facc15' },
            ]"
          />
          <ChartLatencyDual
            :title="t('node.chart.diskIo')"
            :series="[
              { name: t('node.read'), data: diskReadSeries, color: '#22d3ee' },
              { name: t('node.write'), data: diskWriteSeries, color: '#c084fc' },
            ]"
          />
          <ChartLatency :title="t('node.chart.load')" :data="loadSeries" color="#fb923c" />
          <ChartLatency :title="t('node.chart.temp')" :data="tempSeries" color="#f87171" />
          <ChartLatency :title="t('node.chart.swap')" :data="swapSeries" color="#fbbf24" />
        </div>
        </div>

        <div v-if="agent.note || agent.expire_at || agent.monthly_quota_gb != null || agent.price != null" class="glass p-4">
          <h3 class="mb-3 text-lg font-semibold">{{ t('node.notePlan') }}</h3>
          <div v-if="agent.note" class="mb-3 rounded-lg bg-surface px-4 py-3 text-sm text-content">{{ agent.note }}</div>
          <div class="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div v-if="agent.monthly_quota_gb != null" class="flex justify-between gap-4 border-b border-divider py-1">
              <span class="text-muted">{{ t('node.quotaMonthly') }}</span><span class="text-content">{{ formatBytes(agent.monthly_quota_gb * 1024 ** 3) }}</span>
            </div>
            <div v-if="agent.expire_at" class="flex justify-between gap-4 border-b border-divider py-1">
              <span class="text-muted">{{ t('node.expireAt') }}</span><span class="text-content">{{ formatDate(agent.expire_at) }}</span>
            </div>
            <div v-if="agent.price != null" class="flex justify-between gap-4 border-b border-divider py-1">
              <span class="text-muted">{{ t('node.price') }}</span>
              <span class="text-content">{{ agent.currency || '' }} {{ formatNumber(agent.price, 2) }}<span v-if="agent.billing_cycle"> / {{ t('node.daysCycle', { n: agent.billing_cycle }) }}</span></span>
            </div>
          </div>
        </div>

        <div v-if="agent.disks?.length" class="glass p-4">
          <h3 class="mb-3 text-lg font-semibold">{{ t('node.disks') }}</h3>
          <div class="space-y-2">
            <div v-for="disk in agent.disks" :key="disk.mount" class="flex flex-col gap-2 rounded-lg bg-surface px-4 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span class="text-content">{{ disk.mount }}</span>
              <div class="flex items-center gap-4">
                <div class="h-2 w-24 flex-shrink-0 overflow-hidden rounded-full bg-surface sm:w-32">
                  <div class="h-full bg-sky-500" :style="{ width: `${Math.min(disk.pct || 0, 100)}%` }" />
                </div>
                <span class="text-muted">{{ formatBytes(disk.used) }} / {{ formatBytes(disk.total) }} ({{ formatPercent(disk.pct) }})</span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="diskPredict.length" class="glass p-4">
          <h3 class="mb-3 text-lg font-semibold">{{ t('node.diskEta') }}</h3>
          <div class="space-y-2 text-sm">
            <div v-for="d in diskPredict" :key="d.mount" class="flex items-center justify-between rounded-lg bg-surface px-4 py-2">
              <span class="text-content">{{ d.mount }}</span>
              <span class="text-muted">
                <template v-if="d.eta">{{ t('node.etaIn', { eta: d.eta, days: d.days ?? 0 }) }}</template>
                <template v-else>{{ t('node.growthFlat') }}</template>
              </span>
            </div>
          </div>
        </div>

        <div v-show="detailTab === 'latency'" class="glass p-4">
          <h3 class="mb-3 text-lg font-semibold">{{ t('node.netQuality') }}</h3>
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <span
              v-for="r in RANGES"
              :key="r"
              @click="switchRange(r)"
              class="cursor-pointer rounded-full px-3 py-1 text-xs transition-colors"
              :class="currentRange === r ? 'bg-sky-500 text-white' : 'bg-surface text-muted hover:text-sky-300'"
            >{{ t('node.range.' + r) }}</span>
          </div>
          <div class="mb-3 flex flex-wrap gap-4 text-xs">
            <span
              v-for="(points, target) in probes"
              :key="`stat-${target}`"
              class="rounded-lg bg-surface px-3 py-1.5"
            >
              <span class="text-content">{{ target }}</span>
              <span :class="avgProbe(points) != null ? 'text-emerald-400' : 'text-rose-400'" class="ml-2">
                avg {{ avgProbe(points) != null ? `${avgProbe(points)?.toFixed(1)} ms` : t('card.timeout') }}
              </span>
              <span class="ml-2 text-sky-400">P95 {{ p95Probe(points) != null ? `${p95Probe(points)?.toFixed(1)} ms` : '—' }}</span>
              <span class="ml-2 text-muted">{{ t('node.loss', { pct: formatNumber(lossPercent(points), 1) }) }}</span>
            </span>
          </div>
          <ChartLatencyMulti ref="latencyChart" :title="t('node.chart.latency')" :series="probeSeriesList" />
        </div>
      </div>
    </main>
  </div>
</template>
