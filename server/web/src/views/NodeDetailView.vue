<script setup lang="ts">
import { onMounted, computed, ref } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import AppHeader from '../components/AppHeader.vue';
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
    // 详情页可能未被视觉模板预载 sparkline，单独补拉本节点历史（含 disk_used 字节序列，供耗尽预测）
    if (!state.sparklines[agentId.value]) {
      // 用 30d 长窗口取真实磁盘增量，避免短窗口噪声导致 ETA 剧烈抖动（komari 仅 1d 留存，diting 有完整历史）
      const sl = await publicApi.sparklines(agentId.value, '30d');
      state.sparklines = { ...state.sparklines, ...sl };
    }
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

// 磁盘耗尽预测：基于最近 sparkline 的 disk_used 真实字节增量线性外推（对齐 komari 整机口径）
const diskPredict = computed(() => {
  const sl = sparkline.value;
  if (!sl || sl.length < 2) return null;
  const dayMs = 86400000;
  const first = sl[0], last = sl[sl.length - 1];
  const spanDays = Math.max((last.ts - first.ts) / dayMs, 0.01);
  const startUsed = first.disk_used ?? 0;
  const endUsed = last.disk_used ?? 0;
  const total = last.disk_total ?? 0;
  if (!total) return null;
  // 真实增量字节：末值 - 首值（komari 取 MetricDisk 历史差值，而非当前使用率）
  const delta = endUsed - startUsed;
  const dailyGrowth = delta / spanDays; // 字节/天
  const pct = total > 0 ? (endUsed / total) * 100 : 0;
  if (dailyGrowth <= 0) {
    // 无增长或下降：趋势平稳，无法预测耗尽
    return { eta: null as string | null, pct, days: null as number | null, total, used: endUsed, stable: true };
  }
  const remain = Math.max(total - endUsed, 0);
  const days = remain / dailyGrowth;
  const eta = new Date(Date.now() + days * dayMs);
  return {
    eta: eta.toISOString().slice(0, 10),
    pct,
    days: Math.floor(days),
    total,
    used: endUsed,
    stable: false,
  };
});

onMounted(load);
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
        <!-- 标题区（状态点 + 国旗 + 名称 + 版本） -->
        <div class="glass p-5">
          <div class="flex flex-wrap items-center gap-3">
            <img v-if="agent.country || agent.country_code" :src="`/flags/${(agent.country_code || agent.country || '').toLowerCase()}.svg`" class="h-6 w-8 rounded-sm" :alt="agent.country" />
            <h1 class="text-2xl font-bold">{{ agent.name }}</h1>
            <span class="status-dot" :class="agent.online ? 'status-online' : 'status-offline'" />
            <span
              class="rounded-full px-3 py-1 text-xs"
              :class="agent.online ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'"
            >{{ agent.online ? t('common.online') : t('common.offline') }}</span>
            <span v-if="agent.version" class="ml-auto rounded-full bg-surface px-3 py-1 text-xs text-secondary">v{{ agent.version }}</span>
          </div>
          <p class="mt-2 text-sm text-muted">{{ agent.os }} · {{ agent.hostname }} · {{ agent.id }}</p>
        </div>

        <div class="space-y-6">
          <!-- 核心占比指标（图标 + 标签 + 大数值 + 迷你进度条） -->
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div class="rounded-xl bg-slate-500/5 p-3">
              <div class="mb-1 flex items-center gap-1.5 text-xs text-secondary">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none"/></svg>
                {{ t('node.metric.cpu') }}
              </div>
              <div class="text-xl font-semibold text-content">{{ formatPercent(agent.cpu) }}</div>
              <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-500/20">
                <div class="h-full rounded-full bg-sky-500" :style="{ width: `${Math.min(agent.cpu || 0, 100)}%` }" />
              </div>
            </div>
            <div class="rounded-xl bg-slate-500/5 p-3">
              <div class="mb-1 flex items-center gap-1.5 text-xs text-secondary">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="9"/></svg>
                {{ t('node.metric.mem') }}
              </div>
              <div class="text-xl font-semibold text-content">{{ formatPercent(agent.mem_pct) }}</div>
              <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-500/20">
                <div class="h-full rounded-full bg-violet-500" :style="{ width: `${Math.min(agent.mem_pct || 0, 100)}%` }" />
              </div>
              <div class="mt-1 text-[10px] text-muted">{{ formatBytes(agent.mem_used) }} / {{ formatBytes(agent.mem_total) }}</div>
            </div>
            <div class="rounded-xl bg-slate-500/5 p-3">
              <div class="mb-1 flex items-center gap-1.5 text-xs text-secondary">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/></svg>
                {{ t('node.metric.disk') }}
              </div>
              <div class="text-xl font-semibold text-content">{{ formatPercent(agent.disk_pct) }}</div>
              <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-500/20">
                <div class="h-full rounded-full bg-emerald-500" :style="{ width: `${Math.min(agent.disk_pct || 0, 100)}%` }" />
              </div>
              <div class="mt-1 text-[10px] text-muted">{{ formatBytes(agent.disk_used) }} / {{ formatBytes(agent.disk_total) }}</div>
            </div>
            <div class="rounded-xl bg-slate-500/5 p-3">
              <div class="mb-1 flex items-center gap-1.5 text-xs text-secondary">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
                {{ t('node.metric.swap') }}
              </div>
              <div class="text-xl font-semibold text-content">{{ formatPercent(agent.swap_pct) }}</div>
              <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-500/20">
                <div class="h-full rounded-full bg-amber-500" :style="{ width: `${Math.min(agent.swap_pct || 0, 100)}%` }" />
              </div>
            </div>
          </div>

          <!-- 状态 / 流量 / 负载（图标 + 标签 + 数值，紧凑网格） -->
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div class="rounded-xl bg-slate-500/5 p-3">
              <div class="mb-1 flex items-center gap-1.5 text-xs text-secondary">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                {{ t('node.metric.uptime') }}
              </div>
              <div class="text-lg font-semibold text-content">{{ formatDuration(agent.uptime) }}</div>
            </div>
            <div class="rounded-xl bg-slate-500/5 p-3">
              <div class="mb-1 flex items-center gap-1.5 text-xs text-secondary">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z"/></svg>
                {{ t('node.metric.temp') }}
              </div>
              <div class="text-lg font-semibold text-content">{{ agent.temp != null ? `${formatNumber(agent.temp, 1)}°C` : '—' }}</div>
            </div>
            <div class="rounded-xl bg-slate-500/5 p-3">
              <div class="mb-1 flex items-center gap-1.5 text-xs text-secondary">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>
                {{ t('node.metric.load') }}
              </div>
              <div class="text-lg font-semibold text-content">{{ formatNumber(agent.load1 || 0) }}</div>
              <div class="mt-0.5 text-[10px] text-muted">5m {{ formatNumber(agent.load5 || 0) }} · 15m {{ formatNumber(agent.load15 || 0) }}</div>
            </div>
            <div class="rounded-xl bg-slate-500/5 p-3">
              <div class="mb-1 flex items-center gap-1.5 text-xs text-secondary">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18"/><path d="M7 8l5-5 5 5"/></svg>
                {{ t('node.metric.rxRate') }}
              </div>
              <div class="text-lg font-semibold text-content">{{ formatBitsPerSecond(agent.net_rx_rate) }}</div>
            </div>
            <div class="rounded-xl bg-slate-500/5 p-3">
              <div class="mb-1 flex items-center gap-1.5 text-xs text-secondary">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21V3"/><path d="M7 16l5 5 5-5"/></svg>
                {{ t('node.metric.txRate') }}
              </div>
              <div class="text-lg font-semibold text-content">{{ formatBitsPerSecond(agent.net_tx_rate) }}</div>
            </div>
            <div class="rounded-xl bg-slate-500/5 p-3">
              <div class="mb-1 flex items-center gap-1.5 text-xs text-secondary">
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
                {{ t('node.metric.traffic') }}
              </div>
              <div class="text-lg font-semibold text-content">{{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) }}</div>
            </div>
          </div>

          <!-- 分组信息卡（系统 / 存储 / 网络） -->
          <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div class="glass p-4">
              <h3 class="mb-3 text-sm font-semibold text-secondary">{{ t('node.sec.system') }}</h3>
              <div class="space-y-1 text-sm">
                <div class="flex justify-between gap-4 py-1"><span class="text-muted">{{ t('node.hostname') }}</span><span class="text-content">{{ agent.hostname || '—' }}</span></div>
                <div class="flex justify-between gap-4 py-1"><span class="text-muted">{{ t('node.os') }}</span><span class="text-content">{{ agent.os || '—' }}</span></div>
                <div class="flex justify-between gap-4 py-1"><span class="text-muted">{{ t('node.agentVersion') }}</span><span class="text-content">{{ agent.version || '—' }}</span></div>
                <div class="flex justify-between gap-4 py-1"><span class="text-muted">{{ t('node.agentId') }}</span><span class="text-content">{{ agent.id }}</span></div>
              </div>
            </div>

            <div class="glass p-4">
              <h3 class="mb-3 text-sm font-semibold text-secondary">{{ t('node.sec.storage') }}</h3>
              <div v-if="agent.disks?.length" class="space-y-2">
                <div v-for="disk in agent.disks" :key="disk.mount" class="flex flex-col gap-1">
                  <div class="flex items-center justify-between text-sm">
                    <span class="text-content">{{ disk.mount }}</span>
                    <span class="text-muted">{{ formatPercent(disk.pct) }}</span>
                  </div>
                  <div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-500/20">
                    <div class="h-full rounded-full bg-emerald-500" :style="{ width: `${Math.min(disk.pct || 0, 100)}%` }" />
                  </div>
                  <div class="text-[10px] text-muted">{{ formatBytes(disk.used) }} / {{ formatBytes(disk.total) }}</div>
                </div>
              </div>
              <div v-else class="text-sm text-muted">{{ formatPercent(agent.disk_pct) }} · {{ formatBytes(agent.disk_used) }} / {{ formatBytes(agent.disk_total) }}</div>
            </div>

            <div class="glass p-4">
              <h3 class="mb-3 text-sm font-semibold text-secondary">{{ t('node.sec.network') }}</h3>
              <div class="space-y-1 text-sm">
                <div class="flex justify-between gap-4 py-1"><span class="text-muted">{{ t('node.metric.rxRate') }}</span><span class="text-content">{{ formatBitsPerSecond(agent.net_rx_rate) }}</span></div>
                <div class="flex justify-between gap-4 py-1"><span class="text-muted">{{ t('node.metric.txRate') }}</span><span class="text-content">{{ formatBitsPerSecond(agent.net_tx_rate) }}</span></div>
                <div class="flex justify-between gap-4 py-1"><span class="text-muted">{{ t('node.metric.rxMonth') }}</span><span class="text-content">{{ formatBytes(agent.net_rx_month) }}</span></div>
                <div class="flex justify-between gap-4 py-1"><span class="text-muted">{{ t('node.metric.txMonth') }}</span><span class="text-content">{{ formatBytes(agent.net_tx_month) }}</span></div>
              </div>
              <div v-if="agent.monthly_quota_gb != null" class="mt-3">
                <div class="mb-1 flex items-center justify-between text-xs text-muted">
                  <span>{{ t('node.metric.quota') }}</span>
                  <span>{{ formatBytes(((agent.net_rx_month || 0) + (agent.net_tx_month || 0))) }} / {{ formatBytes(agent.monthly_quota_gb * 1024 ** 3) }}</span>
                </div>
                <div class="h-2 w-full overflow-hidden rounded-full bg-slate-500/20">
                  <div
                    class="h-full rounded-full"
                    :class="(((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) / (agent.monthly_quota_gb * 1024 ** 3) * 100) > 80 ? 'bg-rose-500' : (((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) / (agent.monthly_quota_gb * 1024 ** 3) * 100) > 50 ? 'bg-amber-500' : 'bg-sky-500'"
                    :style="{ width: `${Math.min(((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) / (agent.monthly_quota_gb * 1024 ** 3) * 100, 100)}%` }"
                  />
                </div>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <ChartLatency :title="t('node.chart.cpu')" :data="cpuSeries" color="#38bdf8" />
          <ChartLatency :title="t('node.chart.mem')" :data="memSeries" color="#a78bfa" />
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

        <div v-if="(agent.note || agent.expire_at || agent.monthly_quota_gb != null || agent.price != null) || diskPredict" class="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div v-if="agent.note || agent.expire_at || agent.monthly_quota_gb != null || agent.price != null" class="glass p-5">
            <h3 class="mb-4 flex items-center gap-2 text-base font-semibold text-content">
              <svg class="h-4 w-4 text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/></svg>
              {{ t('node.notePlan') }}
            </h3>
            <div v-if="agent.note" class="mb-4 rounded-xl border-l-2 border-sky-400/70 bg-surface/60 px-4 py-3 text-sm leading-relaxed text-content">{{ agent.note }}</div>
            <div class="flex flex-wrap gap-2">
              <span v-if="agent.monthly_quota_gb != null" class="inline-flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1.5 text-xs">
                <svg class="h-3.5 w-3.5 text-sky-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4v6c0 5-4 7-8 8-4-1-8-3-8-8V7z"/></svg>
                <span class="text-muted">{{ t('node.quotaMonthly') }}</span>
                <span class="font-semibold text-sky-300">{{ formatBytes(agent.monthly_quota_gb * 1024 ** 3) }}</span>
              </span>
              <span v-if="agent.expire_at" class="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs">
                <svg class="h-3.5 w-3.5 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>
                <span class="text-muted">{{ t('node.expireAt') }}</span>
                <span class="font-semibold text-emerald-300">{{ formatDate(agent.expire_at) }}</span>
              </span>
              <span v-if="agent.price != null" class="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs">
                <svg class="h-3.5 w-3.5 text-amber-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 10h4.5a2 2 0 0 1 0 4H9"/></svg>
                <span class="text-muted">{{ t('node.price') }}</span>
                <span class="font-semibold text-amber-300">{{ agent.currency || '' }} {{ formatNumber(agent.price, 2) }}<span v-if="agent.billing_cycle"> / {{ t('node.daysCycle', { n: agent.billing_cycle }) }}</span></span>
              </span>
            </div>
          </div>

          <div v-if="diskPredict" class="glass p-5">
            <div class="mb-4 flex items-center justify-between">
              <h3 class="flex items-center gap-2 text-base font-semibold text-content">
                <svg class="h-4 w-4 text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>
                {{ t('node.diskEta') }}
              </h3>
              <span
                class="rounded-full px-2.5 py-0.5 text-xs font-medium"
                :class="diskPredict.pct >= 80 ? 'bg-rose-400/15 text-rose-300' : diskPredict.pct >= 50 ? 'bg-amber-400/15 text-amber-300' : 'bg-sky-400/15 text-sky-300'"
              >{{ formatPercent(diskPredict.pct) }}</span>
            </div>
            <div class="mb-1 flex items-baseline justify-between">
              <span class="text-2xl font-bold text-content">{{ formatBytes(diskPredict.used) }}</span>
              <span class="text-sm text-muted">/ {{ formatBytes(diskPredict.total) }}</span>
            </div>
            <div class="mb-4 h-2 w-full overflow-hidden rounded-full bg-surface">
              <div
                class="h-full rounded-full transition-all"
                :class="diskPredict.pct >= 80 ? 'bg-gradient-to-r from-rose-500 to-rose-400' : diskPredict.pct >= 50 ? 'bg-gradient-to-r from-amber-500 to-amber-400' : 'bg-gradient-to-r from-sky-500 to-sky-400'"
                :style="{ width: Math.min(diskPredict.pct, 100) + '%' }"
              ></div>
            </div>
            <div class="flex items-center justify-between rounded-xl bg-surface/60 px-4 py-3">
              <span class="flex items-center gap-2 text-sm text-muted">
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                {{ t('node.etaLabel') }}
              </span>
              <span v-if="diskPredict.eta" class="text-sm font-semibold text-sky-300">{{ t('node.etaIn', { eta: diskPredict.eta, days: diskPredict.days ?? 0 }) }}</span>
              <span v-else class="rounded-full bg-emerald-400/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">{{ t('node.growthFlat') }}</span>
            </div>
          </div>
        </div>

        <div class="glass p-4">
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
          <ChartLatencyMulti :title="t('node.chart.latency')" :series="probeSeriesList" />
        </div>
      </div>
    </main>
  </div>
</template>
