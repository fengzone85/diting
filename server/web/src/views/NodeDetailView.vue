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
import {
  Cpu,
  Computer,
  Code,
  Timer,
  Server,
  Memory,
  Switch,
  HardDisk,
  TransferData,
  DashboardOne,
  ApplicationTwo,
  VideoOne,
} from '@icon-park/vue-next';

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

// 网络卡背景进度层宽度：月流量已用 / 配额占用率
const netUsagePct = computed(() => {
  const a = agent.value;
  if (!a || a.monthly_quota_gb == null || a.monthly_quota_gb <= 0) return 0;
  const used = (a.net_rx_month || 0) + (a.net_tx_month || 0);
  const quota = a.monthly_quota_gb * 1024 ** 3;
  return Math.min((used / quota) * 100, 100);
});

// 硬件卡动态条目：架构/虚拟化/GPU/物理核心（无字段则显示 -；不对指纹字段扩展采集）
const hwDynamic = computed(() => {
  const a = agent.value;
  if (!a) return [];
  const items: { label: string; value: string; icon: any }[] = [];
  // 架构（无 IP 时显示，diting 当前未上报 arch → -）
  items.push({ label: t('node.arch'), value: (a as any).arch || '—', icon: ApplicationTwo });
  // 虚拟化
  items.push({ label: t('node.virtualization'), value: (a as any).virtualization || '—', icon: Server });
  // GPU（仅当存在时渲染，否则跳过）
  if ((a as any).gpu_name) {
    items.push({ label: t('node.gpu'), value: (a as any).gpu_name, icon: VideoOne });
  }
  // 物理核心（仅当为有效数字时渲染）
  if (typeof (a as any).cpu_physical_cores === 'number' && (a as any).cpu_physical_cores > 0) {
    items.push({ label: t('node.physicalCores'), value: String((a as any).cpu_physical_cores), icon: Cpu });
  }
  return items;
});

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
          <p class="mt-2 text-sm text-muted">{{ agent.os }} · {{ agent.id }}</p>
        </div>

        <div class="space-y-6">
          <!-- 顶部信息条：对齐 glassmorphism 节点页顶部水平指标条 -->
          <div class="flex flex-wrap gap-3">
            <div class="flex items-center gap-2 rounded-xl bg-surface/40 px-3 py-2">
              <svg class="h-4 w-4 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
              <span class="text-xs text-muted">{{ t('node.metric.traffic') }}</span>
              <span class="text-sm font-semibold text-cyan-300">{{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0)) }}</span>
            </div>
            <div class="flex items-center gap-2 rounded-xl bg-surface/40 px-3 py-2">
              <svg class="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="9"/></svg>
              <span class="text-xs text-muted">{{ t('node.metric.quota') }}</span>
              <span class="text-sm font-semibold text-emerald-300">{{ agent.monthly_quota_gb != null ? formatBytes(agent.monthly_quota_gb * 1024 ** 3) : '∞' }}</span>
            </div>
            <div class="flex items-center gap-2 rounded-xl bg-surface/40 px-3 py-2">
              <svg class="h-4 w-4 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              <span class="text-xs text-muted">{{ t('node.metric.uptime') }}</span>
              <span class="text-sm font-semibold text-indigo-300">{{ formatDuration(agent.uptime) }}</span>
            </div>
          </div>
          <!-- 顶部四卡：严格对齐 Komari Glassmorphism 节点详情页（lg 以上 2 列，不强制等高） -->
          <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <!-- 硬件信息：glass 毛玻璃卡 + 纵向条目 -->
            <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
              <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.hardware') }}</h3>
              <!-- CPU 型号块（对齐 Komari 硬件卡顶部大块） -->
              <div class="mb-3 flex flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                <div class="flex items-center gap-1 text-xs text-muted-foreground">
                  <Cpu :size="14" />
                  <span>{{ t('node.cpuModel') }}</span>
                </div>
                <span class="text-xs sm:text-sm text-content">{{ agent.cpu_name || t('node.unknown') }}</span>
                <!-- 芯片天梯评分条：无型号则显示灰色未知占位条 -->
                <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-500/20">
                  <div class="h-full rounded-full bg-gray-400" style="width: 0%"></div>
                </div>
                <span class="text-[10px] text-content/60">{{ t('node.unknown') }}</span>
              </div>
              <!-- 动态条目：架构/虚拟化/GPU/物理核心（按需渲染，无则显 -） -->
              <div class="grid grid-cols-2 gap-1">
                <div v-for="item in hwDynamic" :key="item.label" class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground">
                    <component :is="item.icon" :size="14" />
                    <span>{{ item.label }}</span>
                  </span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ item.value }}</span>
                </div>
              </div>
            </div>

            <!-- 系统信息 -->
            <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
              <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.system') }}</h3>
              <div class="grid grid-cols-2 gap-1">
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><Computer :size="14" /><span>{{ t('node.os') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ agent.os || '—' }}</span>
                </div>
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><Code :size="14" /><span>{{ t('node.kernel') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ agent.kernel_version || '—' }}</span>
                </div>
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><Timer :size="14" /><span>{{ t('node.metric.uptime') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ formatDuration(agent.uptime) || '—' }}</span>
                </div>
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><Server :size="14" /><span>{{ t('node.merchant') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ agent.merchant || '—' }}</span>
                </div>
              </div>
            </div>

            <!-- 存储信息：glass 毛玻璃卡 + 纵向紧凑条目 -->
            <div class="glass group flex flex-col rounded-md border-none p-3 transition-all">
              <h3 class="mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.storage') }}</h3>
              <div class="grid grid-cols-3 gap-1">
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><Memory :size="14" /><span>{{ t('node.storage.mem') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ formatBytes(agent.mem_total, 1) }}</span>
                </div>
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><Switch :size="14" /><span>{{ t('node.storage.swap') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ formatPercent(agent.swap_pct) }}</span>
                </div>
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><HardDisk :size="14" /><span>{{ t('node.storage.disk') }}</span></span>
                  <span class="truncate text-xs sm:text-sm text-content">{{ formatBytes(agent.disk_total, 1) }}</span>
                </div>
              </div>
            </div>

            <!-- 网络信息：glass 毛玻璃卡 + 横排两块 + 进度条背景 -->
            <div class="glass group relative flex flex-col overflow-hidden rounded-md border-none p-3 transition-all">
              <div
                v-if="agent.monthly_quota_gb != null && netUsagePct > 0"
                class="pointer-events-none absolute inset-y-0 left-0 rounded-sm bg-gradient-to-r from-transparent to-slate-500/10 transition-[width] duration-300 ease-out"
                :style="{ width: Math.min(netUsagePct, 100) + '%' }"
              ></div>
              <h3 class="relative z-10 mb-2 text-xs font-medium tracking-wider text-secondary">{{ t('node.sec.network') }}</h3>
              <div class="relative z-10 grid grid-cols-2 gap-1">
                <!-- 总流量块 -->
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><TransferData :size="14" /><span>{{ t('node.netTotal') }}</span></span>
                  <span v-if="agent.monthly_quota_gb != null" class="truncate text-xs sm:text-sm text-content">{{ formatBytes((agent.net_rx_month || 0) + (agent.net_tx_month || 0), 1) }} / {{ formatBytes(agent.monthly_quota_gb * 1024 ** 3, 1) }}</span>
                  <span v-else class="truncate text-xs sm:text-sm text-content">{{ t('node.unlimitedTraffic') }}</span>
                </div>
                <!-- 网络速率块 -->
                <div class="flex min-w-0 flex-col gap-1 rounded-sm bg-slate-500/5 p-2">
                  <span class="flex gap-1 items-center text-xs text-muted-foreground"><DashboardOne :size="14" /><span>{{ t('node.netRate') }}</span></span>
                  <span class="truncate whitespace-nowrap text-xs sm:text-sm text-content">↑ {{ formatBitsPerSecond(agent.net_tx_rate) }} ↓ {{ formatBitsPerSecond(agent.net_rx_rate) }}</span>
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

        <div v-if="(agent.note || agent.expire_at || agent.monthly_quota_gb != null || agent.price != null || agent.hostname || agent.group) || diskPredict" class="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div v-if="agent.note || agent.expire_at || agent.monthly_quota_gb != null || agent.price != null || agent.hostname || agent.group" class="glass p-5">
            <h3 class="mb-4 flex items-center gap-2 text-base font-semibold text-content">
              <svg class="h-4 w-4 text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/></svg>
              {{ t('node.notePlan') }}
            </h3>
            <div v-if="agent.note" class="mb-4 rounded-xl border-l-2 border-sky-400/70 bg-surface/60 px-4 py-3 text-sm leading-relaxed text-content">{{ agent.note }}</div>
            <div class="flex flex-wrap gap-2">
              <span v-if="agent.hostname" class="inline-flex items-center gap-1.5 rounded-full border border-slate-400/30 bg-slate-400/10 px-3 py-1.5 text-xs">
                <span class="text-muted">{{ t('node.hostname') }}</span>
                <span class="font-semibold text-slate-200">{{ agent.hostname }}</span>
              </span>
              <span v-if="agent.group" class="inline-flex items-center gap-1.5 rounded-full border border-slate-400/30 bg-slate-400/10 px-3 py-1.5 text-xs">
                <span class="text-muted">{{ t('node.group') }}</span>
                <span class="font-semibold text-slate-200">{{ agent.group }}</span>
              </span>
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
            <!-- 占用率进度条：铺满「已用/总容量」内层胶囊的高度（背景层，半透明实色，宽度=占用率） -->
            <div class="relative mb-4 flex items-baseline justify-between overflow-hidden rounded-xl bg-surface/40 px-4 py-3">
              <div
                class="pointer-events-none absolute inset-y-0 left-0 rounded-xl transition-[width,background-color] duration-300 ease-out"
                :class="diskPredict.pct >= 80 ? 'bg-red-500/20' : diskPredict.pct >= 50 ? 'bg-amber-500/20' : 'bg-emerald-500/20'"
                :style="{ width: Math.min(diskPredict.pct, 100) + '%' }"
              ></div>
              <span class="relative z-10 text-2xl font-bold text-content">{{ formatBytes(diskPredict.used) }}</span>
              <span class="relative z-10 text-sm text-muted">/ {{ formatBytes(diskPredict.total) }}</span>
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
