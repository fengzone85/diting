<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import ChartLatency from '../../components/ChartLatency.vue';
import DashboardBoard from '../../components/admin/DashboardBoard.vue';
import { useAdmin } from '../../composables/useAdmin';
import { useApp } from '../../composables/useApp';
import { useI18n } from '../../composables/useI18n';
import { adminApi } from '../../services/adminApi';
import type { Billing, ChartPoint, DashboardLayoutItem } from '../../services/types';
import { formatBytes, formatDuration, formatPercent } from '../../utils/format';

const admin = useAdmin();
const app = useApp();
const { t } = useI18n();
const billing = ref<Billing | null>(null);
const testingAlert = ref(false);
const testMessage = ref('');

const offlineAgents = computed(() => admin.state.agents.filter(a => !a.latest?.cpu && a.last_seen));
const avgCpu = computed(() => {
  const vals = admin.state.agents.map(a => a.latest?.cpu).filter((v): v is number => v != null);
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : undefined;
});
const avgMem = computed(() => {
  const vals = admin.state.agents.map(a => a.latest?.mem_pct).filter((v): v is number => v != null);
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : undefined;
});

// ---- 仪表盘卡片（可可视化调整，对齐 Komari）------------------------------
// 卡片内容在这里算好，布局（顺序 / 宽度 / 高度 / 显隐）由 DashboardBoard 管理，
// 并写入服务端 ui.admin_dashboard_layout（全局生效）。
const CARD_KEYS = ['total', 'online', 'offline', 'monthly_cost', 'avg_cpu', 'avg_mem', 'db_size', 'public_nodes'] as const;
type CardKey = typeof CARD_KEYS[number];

const cardMeta = computed<Record<CardKey, { label: string; value: string | number; variant?: 'default' | 'success' | 'warning' | 'danger' }>>(() => ({
  total: { label: t('dashboard.totalAgents'), value: (admin.state.overview?.total as number) ?? '-' },
  online: { label: t('dashboard.online'), value: (admin.state.overview?.online as number) ?? '-', variant: 'success' },
  offline: { label: t('dashboard.offline'), value: (admin.state.overview?.offline as number) ?? '-', variant: 'danger' },
  monthly_cost: {
    label: t('dashboard.monthlyCost'),
    value: billing.value ? billing.value.currency + billing.value.monthly_total.toFixed(2) : '-',
    variant: 'warning',
  },
  avg_cpu: { label: t('dashboard.avgCpu'), value: formatPercent(avgCpu.value) },
  avg_mem: { label: t('dashboard.avgMem'), value: formatPercent(avgMem.value) },
  db_size: { label: t('dashboard.dbSize'), value: formatBytes(admin.state.overview?.db_size_bytes as number | undefined) },
  public_nodes: { label: t('public.nodes'), value: app.state.meta?.public_enabled ? 'ON' : 'OFF' },
}));

const dashboardCards = computed(() => CARD_KEYS.map((k) => ({ id: k as string, ...cardMeta.value[k] })));

// null = 服务端从未配置过布局 → 看板用默认布局（全量卡片，标准宽/精简高）
const dashboardLayout = computed<DashboardLayoutItem[] | null>(() => {
  const raw = (admin.state.settings?.ui as Record<string, unknown> | undefined)?.admin_dashboard_layout;
  return Array.isArray(raw) ? (raw as DashboardLayoutItem[]) : null;
});

function onLayoutSaved() {
  admin.refresh().catch(() => {});
}

// B5: 集群平均 CPU/内存趋势（聚合所有受控端时序）
// 后端 /agents/sparklines/overview 已按时间桶跨所有 agent 在 SQL 层聚合出平均曲线，
// 前端只渲染最终点数（几十~几百点），彻底规避「62 台 × 每 agent 2000 点全量拉取再逐点聚合」的卡顿。
const chartRange = ref<'1h' | '6h' | '24h' | '7d' | '30d'>('6h');
const sparkError = ref('');

const cpuTrend = ref<ChartPoint[]>([]);
const memTrend = ref<ChartPoint[]>([]);

async function loadSparklines() {
  sparkError.value = '';
  try {
    const rows = await adminApi.clusterTrend(chartRange.value);
    cpuTrend.value = rows.filter(r => r.cpu != null).map(r => ({ t: r.ts, v: r.cpu as number }));
    memTrend.value = rows.filter(r => r.mem_pct != null).map(r => ({ t: r.ts, v: r.mem_pct as number }));
  } catch (e) {
    sparkError.value = t('dashboard.trendFailed', { msg: (e as Error).message || t('common.unknownError') });
  }
}

onMounted(async () => {
  try {
    billing.value = await adminApi.billingOverview();
  } catch {
    billing.value = null;
  }
  await loadSparklines();
});

async function changeRange(r: '1h' | '6h' | '24h' | '7d' | '30d') {
  chartRange.value = r;
  await loadSparklines();
}

async function testAlert() {
  testingAlert.value = true;
  testMessage.value = '';
  try {
    await adminApi.testAlert();
    testMessage.value = t('dashboard.testSent');
  } catch (e) {
    testMessage.value = t('dashboard.sendFailed', { msg: (e as Error).message || t('common.unknownError') });
  } finally {
    testingAlert.value = false;
  }
}
</script>

<template>
  <div>
    <h1 class="mb-5 text-2xl font-bold">{{ t('dashboard.title') }}</h1>
    <div v-if="admin.state.error" class="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">
      {{ admin.state.error }}
    </div>
    <DashboardBoard :cards="dashboardCards" :model="dashboardLayout" @saved="onLayoutSaved" />
    <div class="mt-6">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{{ t('dashboard.avgCpu') }} / {{ t('dashboard.avgMem') }} {{ t('dashboard.trend') }}</h2>
        <div class="flex gap-1 text-xs">
          <button v-for="r in (['1h','6h','24h','7d','30d'] as const)" :key="r" :class="chartRange === r ? 'bg-sky-500 text-white' : 'bg-slate-800 text-slate-400'" class="rounded px-2 py-1 hover:opacity-80" @click="changeRange(r)">{{ r }}</button>
        </div>
      </div>
      <div v-if="sparkError" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{{ sparkError }}</div>
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartLatency :title="t('dashboard.trendCpu')" :data="cpuTrend" color="#38bdf8" />
        <ChartLatency :title="t('dashboard.trendMem')" :data="memTrend" color="#a78bfa" />
      </div>
    </div>
    <div v-if="testMessage" class="mt-4 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-200">{{ testMessage }}</div>
    <div class="mt-4 flex gap-3">
      <button :disabled="testingAlert" @click="testAlert" class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50">{{ t('dashboard.testAlert') }}</button>
      <router-link to="/admin/billing" class="rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">{{ t('nav.billing') }}</router-link>
      <router-link to="/admin/ai" class="rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">{{ t('nav.ai') }}</router-link>
    </div>
    <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div class="glass p-4">
        <h2 class="mb-4 text-lg font-semibold">{{ t('dashboard.offline') }}</h2>
        <div v-if="!offlineAgents.length" class="text-sm text-slate-500">{{ t('agents.empty') }}</div>
        <div class="space-y-2">
          <div v-for="a in offlineAgents" :key="a.id" class="flex items-center justify-between rounded-lg bg-slate-800/40 px-4 py-2 text-sm">
            <span class="text-slate-300">{{ a.name }}</span>
            <span class="text-slate-500">{{ formatDuration(Math.floor(Date.now() / 1000) - (a.last_seen || 0)) }} 前</span>
          </div>
        </div>
      </div>
      <div class="glass p-4">
        <h2 class="mb-4 text-lg font-semibold">{{ t('dashboard.avgCpu') }} Top3</h2>
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
