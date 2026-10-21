<script setup lang="ts">
import { computed, markRaw, ref, onMounted } from 'vue';
import ChartLatency from '../../components/ChartLatency.vue';
import StatCard from '../../components/ui/StatCard.vue';
import DashboardBoard from '../../components/admin/DashboardBoard.vue';
import OverviewCard from '../../components/admin/dashboard/OverviewCard.vue';
import CapacityCard from '../../components/admin/dashboard/CapacityCard.vue';
import RankCard from '../../components/admin/dashboard/RankCard.vue';
import TrafficCard from '../../components/admin/dashboard/TrafficCard.vue';
import ListCard from '../../components/admin/dashboard/ListCard.vue';
import GroupsCard from '../../components/admin/dashboard/GroupsCard.vue';
import ShortcutsCard from '../../components/admin/dashboard/ShortcutsCard.vue';
import type { DashboardWidgetDef } from '../../components/admin/dashboard/widgets';
import { useAdmin } from '../../composables/useAdmin';
import { useApp } from '../../composables/useApp';
import { useI18n } from '../../composables/useI18n';
import { adminApi } from '../../services/adminApi';
import type { Agent, Billing, ChartPoint, DashboardLayoutItem } from '../../services/types';
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
// 卡片内容在页面侧算好（纯数据），布局（顺序 / 宽度 / 高度 / 显隐）由 DashboardBoard 管理，
// 并写入服务端 ui.admin_dashboard_layout（全局生效）。
// 卡片清单对齐 Komari：概览 / 资源容量 / CPU·内存·磁盘排行 / 流量 / 到期 / 网络品质 /
// 分组 / 快捷操作，外加若干单指标卡。

/** 节点 probes 既可能是 JSON 字符串（服务端快照）也可能是已解析对象 */
function parseProbes(raw: Agent['probes']): Record<string, { ms?: number; loss?: number; ok?: boolean }> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function fmtRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B/s';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}/s`;
}

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

const widgets = computed<DashboardWidgetDef[]>(() => {
  const o = admin.state.overview;
  const ags = admin.state.agents;
  const sum = (f: (a: Agent) => number) => ags.reduce((acc, a) => acc + (f(a) || 0), 0);
  const onlineAgents = ags.filter((a) => a.online);
  const offlineAgents = ags.filter((a) => !a.online);

  // 单指标卡（StatCard）
  const stat = (
    id: string,
    label: string,
    value: string | number,
    extra: { variant?: 'default' | 'success' | 'warning' | 'danger'; sub?: string } = {},
  ): DashboardWidgetDef => ({
    id,
    label,
    component: markRaw(StatCard),
    props: {
      label,
      value,
      variant: extra.variant ?? 'default',
      sub: extra.sub,
      // 固定高度里内容垂直居中，避免单指标卡上下留白不均
      class: 'h-full flex flex-col justify-center',
    },
  });

  // 资源容量
  const cores = sum((a) => a.cores || 0);
  const memTotal = sum((a) => a.latest?.mem_total || a.mem_total || 0);
  const diskTotal = sum((a) => a.latest?.disk_total || a.disk_total || 0);

  // 排行（在线节点，前 5）
  const cpuRows = onlineAgents.slice()
    .sort((x, y) => (y.latest?.cpu ?? y.cpu ?? 0) - (x.latest?.cpu ?? x.cpu ?? 0))
    .slice(0, 5)
    .map((a) => {
      const v = a.latest?.cpu ?? a.cpu ?? 0;
      return { name: a.name, pct: clampPct(v), value: formatPercent(v) };
    });
  const memRows = onlineAgents.slice()
    .sort((x, y) => (y.latest?.mem_pct ?? y.mem_pct ?? 0) - (x.latest?.mem_pct ?? x.mem_pct ?? 0))
    .slice(0, 5)
    .map((a) => {
      const v = a.latest?.mem_pct ?? a.mem_pct ?? 0;
      const cap = a.latest?.mem_total || a.mem_total || 0;
      return {
        name: a.name,
        pct: clampPct(v),
        value: formatPercent(v),
        sub: cap > 0 ? `${formatBytes(a.latest?.mem_used || a.mem_used || 0)} / ${formatBytes(cap)}` : undefined,
      };
    });
  const diskRows = onlineAgents.slice()
    .sort((x, y) => (y.latest?.disk_pct ?? y.disk_pct ?? 0) - (x.latest?.disk_pct ?? x.disk_pct ?? 0))
    .slice(0, 5)
    .map((a) => {
      const v = a.latest?.disk_pct ?? a.disk_pct ?? 0;
      const cap = a.latest?.disk_total || a.disk_total || 0;
      return {
        name: a.name,
        pct: clampPct(v),
        value: formatPercent(v),
        sub: cap > 0 ? `${formatBytes(a.latest?.disk_used || a.disk_used || 0)} / ${formatBytes(cap)}` : undefined,
      };
    });

  // 流量
  const rxMonth = sum((a) => a.net_rx_month || 0);
  const txMonth = sum((a) => a.net_tx_month || 0);
  const rxRate = sum((a) => a.net_rx_rate || 0);
  const txRate = sum((a) => a.net_tx_rate || 0);
  const quotaBytes = sum((a) => (a.monthly_quota_gb || 0) * 1024 ** 3);
  const usedBytes = rxMonth + txMonth;
  const quotaPct = quotaBytes > 0 ? clampPct((usedBytes / quotaBytes) * 100) : null;

  // 到期（30 天内，按剩余天数升序）
  const now = Date.now();
  const expiryRows = ags
    .filter((a) => !!a.expire_at)
    .map((a) => ({ a, days: Math.ceil((new Date(a.expire_at as string).getTime() - now) / 864e5) }))
    .filter((x) => Number.isFinite(x.days) && x.days <= 30)
    .sort((x, y) => x.days - y.days)
    .slice(0, 6)
    .map((x) => ({
      key: x.a.id,
      label: x.a.name,
      value: x.days <= 0 ? t('dashboard.expired') : t('dashboard.daysLeft', { n: x.days }),
      tone: (x.days <= 7 ? 'danger' : 'warning') as 'danger' | 'warning',
    }));

  // 网络品质（probes 平均延迟 / 丢包，按延迟降序取前 5）
  const pingRows = ags
    .map((a) => {
      const vals = Object.values(parseProbes(a.probes)).filter((p) => p && typeof p.ms === 'number');
      if (!vals.length) return null;
      const ms = vals.reduce((s, p) => s + (p.ms || 0), 0) / vals.length;
      const loss = vals.reduce((s, p) => s + (typeof p.loss === 'number' ? p.loss : 0), 0) / vals.length;
      return { a, ms, loss };
    })
    .filter((x): x is { a: Agent; ms: number; loss: number } => !!x)
    .sort((x, y) => y.ms - x.ms)
    .slice(0, 5)
    .map((x) => ({
      key: x.a.id,
      label: x.a.name,
      value: `${x.ms.toFixed(0)}ms · ${x.loss.toFixed(1)}%`,
      tone: (x.ms >= 200 ? 'danger' : x.ms >= 100 ? 'warning' : 'default') as 'danger' | 'warning' | 'default',
    }));

  // 资产
  const remainingTotal = sum((a) => (typeof a.remaining_value === 'number' ? a.remaining_value : 0));
  const totalValue = sum((a) => (a.price && a.price > 0 ? a.price : 0));
  const currency = ags.find((a) => a.price && a.price > 0)?.currency || '¥';
  const remainingText = remainingTotal > 0 ? `${currency}${remainingTotal.toFixed(2)}` : '—';
  const totalValueText = totalValue > 0 ? `${currency}${totalValue.toFixed(2)}` : '—';

  const groups = ((o?.groups as { name: string; total: number; online: number }[] | undefined) ?? [])
    .slice()
    .sort((x, y) => x.name.localeCompare(y.name));

  return [
    {
      id: 'overview',
      label: t('dashboard.cardOverview'),
      component: markRaw(OverviewCard),
      defaultWidth: 'wide',
      props: {
        title: t('dashboard.cardOverview'),
        total: (o?.total as number) ?? 0,
        online: (o?.online as number) ?? 0,
        offline: (o?.offline as number) ?? 0,
        offlineNames: offlineAgents.slice(0, 5).map((a) => a.name),
      },
    },
    stat('online', t('dashboard.online'), (o?.online as number) ?? '-', { variant: 'success' }),
    stat('offline', t('dashboard.offline'), (o?.offline as number) ?? '-', { variant: 'danger' }),
    stat('total', t('dashboard.totalAgents'), (o?.total as number) ?? '-'),
    stat('monthly_cost', t('dashboard.monthlyCost'),
      billing.value ? billing.value.currency + billing.value.monthly_total.toFixed(2) : '-', { variant: 'warning' }),
    stat('remaining_value', t('public.remainingValue'), remainingText,
      { variant: 'success', sub: `${t('public.totalValue')} ${totalValueText}` }),
    stat('avg_cpu', t('dashboard.avgCpu'), formatPercent(avgCpu.value)),
    stat('avg_mem', t('dashboard.avgMem'), formatPercent(avgMem.value)),
    stat('db_size', t('dashboard.dbSize'), formatBytes(o?.db_size_bytes as number | undefined)),
    stat('public_nodes', t('public.nodes'), app.state.meta?.public_enabled ? 'ON' : 'OFF'),
    {
      id: 'capacity',
      label: t('dashboard.cardCapacity'),
      component: markRaw(CapacityCard),
      defaultHeight: 'normal',
      props: { title: t('dashboard.cardCapacity'), cores, memTotal, diskTotal, nodeCount: ags.length },
    },
    {
      id: 'cpu_rank',
      label: t('dashboard.cardCpuRank'),
      component: markRaw(RankCard),
      defaultHeight: 'normal',
      props: { title: t('dashboard.cardCpuRank'), rows: cpuRows },
    },
    {
      id: 'mem_rank',
      label: t('dashboard.cardMemRank'),
      component: markRaw(RankCard),
      defaultHeight: 'normal',
      props: { title: t('dashboard.cardMemRank'), rows: memRows },
    },
    {
      id: 'disk_rank',
      label: t('dashboard.cardDiskRank'),
      component: markRaw(RankCard),
      defaultHeight: 'normal',
      props: { title: t('dashboard.cardDiskRank'), rows: diskRows },
    },
    {
      id: 'traffic',
      label: t('dashboard.cardTraffic'),
      component: markRaw(TrafficCard),
      defaultWidth: 'wide',
      defaultHeight: 'normal',
      props: {
        title: t('dashboard.cardTraffic'),
        rxMonth: formatBytes(rxMonth),
        txMonth: formatBytes(txMonth),
        rxRate: fmtRate(rxRate),
        txRate: fmtRate(txRate),
        quotaPct,
        quotaText: quotaBytes > 0 ? `${formatBytes(usedBytes)} / ${formatBytes(quotaBytes)}` : undefined,
      },
    },
    {
      id: 'expiry',
      label: t('dashboard.cardExpiry'),
      component: markRaw(ListCard),
      defaultHeight: 'normal',
      props: { title: t('dashboard.cardExpiry'), rows: expiryRows, empty: t('dashboard.noExpiring') },
    },
    {
      id: 'ping',
      label: t('dashboard.cardPing'),
      component: markRaw(ListCard),
      defaultHeight: 'normal',
      props: { title: t('dashboard.cardPing'), rows: pingRows },
    },
    {
      id: 'groups',
      label: t('dashboard.cardGroups'),
      component: markRaw(GroupsCard),
      defaultHeight: 'normal',
      props: { title: t('dashboard.cardGroups'), rows: groups },
    },
    {
      id: 'shortcuts',
      label: t('dashboard.cardShortcuts'),
      component: markRaw(ShortcutsCard),
      defaultHeight: 'normal',
      props: { title: t('dashboard.cardShortcuts') },
    },
  ];
});

// 默认布局（未配置过时）：常用概览 + 关键指标 + 流量/到期，其余卡片在「选择卡片」里按需添加
const DEFAULT_LAYOUT_IDS = [
  'overview', 'online', 'offline', 'total', 'monthly_cost', 'remaining_value',
  'avg_cpu', 'avg_mem', 'traffic', 'expiry',
];

// null = 服务端从未配置过布局 → 看板用默认布局
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
    <DashboardBoard
      :widgets="widgets"
      :model="dashboardLayout"
      :default-ids="DEFAULT_LAYOUT_IDS"
      @saved="onLayoutSaved"
    />
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
