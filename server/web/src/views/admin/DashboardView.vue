<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import StatCard from '../../components/ui/StatCard.vue';
import ChartLatency from '../../components/ChartLatency.vue';
import { useAdmin } from '../../composables/useAdmin';
import { useApp } from '../../composables/useApp';
import { useI18n } from '../../composables/useI18n';
import { adminApi } from '../../services/adminApi';
import type { Billing, ChartPoint } from '../../services/types';
import { formatDuration, formatPercent } from '../../utils/format';

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

// B5: 集群平均 CPU/内存趋势（聚合所有受控端时序）
const chartRange = ref<'1h' | '6h' | '24h' | '7d' | '30d'>('6h');
const sparkError = ref('');

function aggregate(rowsByAgent: Record<string, { ts: number; cpu?: number; mem_pct?: number }[]>): { cpu: ChartPoint[]; mem: ChartPoint[] } {
  const byTs = new Map<number, { cpu: number[]; mem: number[] }>();
  for (const rows of Object.values(rowsByAgent)) {
    for (const r of rows) {
      if (!r.ts) continue;
      const bucket = byTs.get(r.ts) || { cpu: [], mem: [] };
      if (typeof r.cpu === 'number') bucket.cpu.push(r.cpu);
      if (typeof r.mem_pct === 'number') bucket.mem.push(r.mem_pct);
      byTs.set(r.ts, bucket);
    }
  }
  const tsList = [...byTs.keys()].sort((a, b) => a - b);
  const cpu = tsList.map(ts => {
    const arr = byTs.get(ts)!.cpu;
    const v = arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2) : 0;
    return { t: ts * 1000, v };
  });
  const mem = tsList.map(ts => {
    const arr = byTs.get(ts)!.mem;
    const v = arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2) : 0;
    return { t: ts * 1000, v };
  });
  return { cpu, mem };
}

const cpuTrend = ref<ChartPoint[]>([]);
const memTrend = ref<ChartPoint[]>([]);

async function loadSparklines() {
  sparkError.value = '';
  try {
    const data = await adminApi.sparklines(chartRange.value);
    const agg = aggregate(data as Record<string, { ts: number; cpu?: number; mem_pct?: number }[]>);
    cpuTrend.value = agg.cpu;
    memTrend.value = agg.mem;
  } catch (e) {
    sparkError.value = '趋势数据加载失败：' + ((e as Error).message || '未知错误');
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
    testMessage.value = '测试告警已发送';
  } catch (e) {
    testMessage.value = '发送失败：' + ((e as Error).message || '未知错误');
  } finally {
    testingAlert.value = false;
  }
}
</script>

<template>
  <div>
    <h1 class="mb-6 text-2xl font-bold">{{ t('dashboard.title') }}</h1>
    <div v-if="admin.state.error" class="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">
      {{ admin.state.error }}
    </div>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard :label="t('dashboard.totalAgents')" :value="(admin.state.overview?.total as number) ?? '-'" />
      <StatCard :label="t('dashboard.online')" :value="(admin.state.overview?.online as number) ?? '-'" variant="success" />
      <StatCard :label="t('dashboard.offline')" :value="(admin.state.overview?.offline as number) ?? '-'" variant="danger" />
      <StatCard :label="t('dashboard.monthlyCost')" :value="billing ? (billing.currency + billing.monthly_total.toFixed(2)) : '-'" variant="warning" />
    </div>
    <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard :label="t('dashboard.avgCpu')" :value="formatPercent(avgCpu)" />
      <StatCard :label="t('dashboard.avgMem')" :value="formatPercent(avgMem)" />
      <StatCard :label="t('public.nodes')" :value="app.state.meta?.public_enabled ? 'ON' : 'OFF'" />
      <StatCard :label="t('settings.title')" :value="app.state.meta?.public_theme || 'default'" />
    </div>
    <div class="mt-6">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-lg font-semibold">{{ t('dashboard.avgCpu') }} / {{ t('dashboard.avgMem') }} 趋势</h2>
        <div class="flex gap-1 text-xs">
          <button v-for="r in (['1h','6h','24h','7d','30d'] as const)" :key="r" :class="chartRange === r ? 'bg-sky-500 text-white' : 'bg-slate-800 text-slate-400'" class="rounded px-2 py-1 hover:opacity-80" @click="changeRange(r)">{{ r }}</button>
        </div>
      </div>
      <div v-if="sparkError" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{{ sparkError }}</div>
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartLatency title="集群平均 CPU (%)" :data="cpuTrend" color="#38bdf8" />
        <ChartLatency title="集群平均内存 (%)" :data="memTrend" color="#a78bfa" />
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
