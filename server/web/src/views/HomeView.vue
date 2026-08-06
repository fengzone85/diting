<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import AppHeader from '../components/AppHeader.vue';
import NodeCard from '../components/NodeCard.vue';
import NodeRow from '../components/NodeRow.vue';
import StatCard from '../components/ui/StatCard.vue';
import Loading from '../components/ui/Loading.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import ErrorMessage from '../components/ui/ErrorMessage.vue';
import { useApp, cardSchemeKeys, customTag } from '../composables/useApp';
import { useI18n } from '../composables/useI18n';
import type { Agent } from '../services/types';

const { state, visibleAgents, groupedAgents, setLayout, setTemplate, setSearch, reorderAgents } = useApp();
const { t } = useI18n();

const searchInput = ref(state.search);
watch(searchInput, (v) => setSearch(v));

const dragId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);

function onDragStart(agent: Agent, e: DragEvent) {
  dragId.value = agent.id;
  (e.dataTransfer as DataTransfer).effectAllowed = 'move';
  try {
    (e.dataTransfer as DataTransfer).setData('text/plain', agent.id);
  } catch {}
}
function onDragEnd() {
  dragId.value = null;
  dragOverId.value = null;
}
function onDragOver(agent: Agent, e: DragEvent) {
  e.preventDefault();
  if (!dragId.value || dragId.value === agent.id) return;
  dragOverId.value = agent.id;
}
function onDrop(target: Agent, e: DragEvent) {
  e.preventDefault();
  if (!dragId.value || dragId.value === target.id) return;
  const ids = visibleAgents.value.map((a) => a.id);
  const from = ids.indexOf(dragId.value);
  const to = ids.indexOf(target.id);
  if (from < 0 || to < 0) return;
  ids.splice(from, 1);
  ids.splice(to, 0, dragId.value);
  reorderAgents(ids);
  dragId.value = null;
  dragOverId.value = null;
}

function groupOrder(groups: Record<string, Agent[]>) {
  return Object.keys(groups).sort((a, b) => a.localeCompare(b));
}

// 卡片尺寸 → 网格列数
const cardSizeClass = computed(() => {
  const size = (state.meta?.card_size as string) || 'comfortable';
  return {
    'grid-cols-1 md:grid-cols-3 xl:grid-cols-4': size === 'large',
    'grid-cols-1 md:grid-cols-2 xl:grid-cols-3': size === 'comfortable',
    'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4': size === 'compact',
    'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6': size === 'mini',
  };
});

// 总览卡片方案（对齐 komari 首页总览卡片方案）
const overviewCards = computed(() => {
  const o = state.overview;
  const ags = state.agents;
  const sum = (f: (a: Agent) => number) => ags.reduce((s, a) => s + (f(a) || 0), 0);
  const expiring = ags.filter((a) => a.expire_at && new Date(a.expire_at).getTime() - Date.now() < 30 * 864e5).length;
  const highLoad = ags.filter((a) => (a.cpu_percent ?? a.cpu ?? 0) >= 80).length;
  const totalRx = sum((a) => a.net_rx_month || 0);
  const totalTx = sum((a) => a.net_tx_month || 0);
  const map: Record<string, { label: string; value: string; variant: 'default' | 'success' | 'danger' | 'warning' }> = {
    online: { label: t('public.online'), value: String(o?.online ?? '-'), variant: 'success' },
    offline: { label: t('public.offline'), value: String(o?.offline ?? '-'), variant: 'danger' },
    warn: { label: t('public.highLoad'), value: String(highLoad), variant: 'warning' },
    total: { label: t('public.totalAgents'), value: String(o?.total ?? '-'), variant: 'default' },
    cpu: { label: t('public.avgCpu'), value: o?.cpu_avg != null ? `${o.cpu_avg.toFixed(1)}%` : '-', variant: 'warning' },
    mem: { label: t('public.avgMem'), value: o?.mem_avg != null ? `${o.mem_avg.toFixed(1)}%` : '-', variant: 'default' },
    load: { label: t('public.highLoad'), value: String(highLoad), variant: 'warning' },
    disk: { label: t('public.diskUsage'), value: '-', variant: 'default' },
    net: { label: t('public.netRate'), value: '-', variant: 'default' },
    swap: { label: t('public.swap'), value: '-', variant: 'default' },
    uptime: { label: t('public.uptime'), value: '-', variant: 'default' },
    traffic: { label: t('public.traffic'), value: fmtBytes(totalRx + totalTx), variant: 'default' },
    traffic_total: { label: t('public.trafficTotal'), value: fmtBytes(totalRx + totalTx), variant: 'default' },
    rx_month: { label: t('public.rxMonth'), value: fmtBytes(totalRx), variant: 'default' },
    tx_month: { label: t('public.txMonth'), value: fmtBytes(totalTx), variant: 'default' },
    price: { label: t('public.monthlyCost'), value: fmtPrice(sum((a) => a.price || 0)), variant: 'default' },
    expire: { label: t('public.expiring'), value: String(expiring), variant: 'warning' },
    quota: { label: t('public.quota'), value: '-', variant: 'default' },
    groups: { label: t('public.groups'), value: String(Object.keys(groupedAgents.value).length), variant: 'default' },
    country: { label: t('public.countries'), value: String(new Set(ags.map((a) => a.country_code).filter(Boolean)).size), variant: 'default' },
    merchant: { label: t('public.merchants'), value: String(new Set(ags.map((a) => a.merchant).filter(Boolean)).size), variant: 'default' },
    gpu: { label: t('public.gpu'), value: '-', variant: 'default' },
  };
  const keys = cardSchemeKeys();
  const cols = Math.min(keys.length, 4);
  return { items: keys.map((k) => map[k]).filter(Boolean), cols };
});

function fmtBytes(n: number): string {
  if (!n) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}
function fmtPrice(n: number): string {
  return n ? `${state.agents[0]?.currency || '¥'}${n.toFixed(2)}` : '-';
}

// 快捷统计条（对齐 komari 快捷控制条）
const quickFilters = computed(() => {
  const ags = state.agents;
  return [
    { key: 'fav', label: t('public.favorites'), count: 0 },
    { key: 'total', label: t('public.totalAgents'), count: ags.length },
    { key: 'offline', label: t('public.offline'), count: ags.filter((a) => !a.online).length },
    { key: 'highload', label: t('public.highLoad'), count: ags.filter((a) => (a.cpu_percent ?? a.cpu ?? 0) >= 80).length },
    { key: 'expiring', label: t('public.expiring'), count: ags.filter((a) => a.expire_at && new Date(a.expire_at).getTime() - Date.now() < 30 * 864e5).length },
  ];
});
const activeQuick = ref<string | null>(null);
const filteredAgents = computed(() => {
  if (!activeQuick.value || activeQuick.value === 'total' || activeQuick.value === 'fav') return visibleAgents.value;
  const ags = visibleAgents.value;
  if (activeQuick.value === 'offline') return ags.filter((a) => !a.online);
  if (activeQuick.value === 'highload') return ags.filter((a) => (a.cpu_percent ?? a.cpu ?? 0) >= 80);
  if (activeQuick.value === 'expiring') return ags.filter((a) => a.expire_at && new Date(a.expire_at).getTime() - Date.now() < 30 * 864e5);
  return ags;
});
</script>

<template>
  <div class="min-h-screen">
    <AppHeader :title="state.meta?.site_title" :meta="state.meta" />
    <main class="mx-auto max-w-7xl px-4 sm:px-6">
      <ErrorMessage v-if="state.error" class="mb-6" :message="state.error" />

      <div class="mb-4 grid gap-3 sm:gap-4" :class="`grid-cols-2 lg:grid-cols-${overviewCards.cols}`">
        <StatCard
          v-for="(c, i) in overviewCards.items"
          :key="i"
          :label="c.label"
          :value="c.value"
          :variant="c.variant"
        />
      </div>

      <!-- 快捷统计条 -->
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <button
          v-for="q in quickFilters"
          :key="q.key"
          class="rounded-full border px-3 py-1 text-xs"
          :class="activeQuick === q.key ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
          @click="activeQuick = activeQuick === q.key ? null : q.key"
        >
          {{ q.label }} <span class="opacity-70">{{ q.count }}</span>
        </button>
      </div>

      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-2">
          <input
            v-model="searchInput"
            :placeholder="t('public.searchPlaceholder')"
            class="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-white outline-none focus:border-sky-500 sm:w-64"
          />
          <span class="whitespace-nowrap text-xs text-slate-500">{{ t('public.nodeCount', { n: filteredAgents.length }) }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-slate-500">{{ t('public.layout') }}</span>
          <button
            v-for="l in ['grid', 'list', 'compact'] as const"
            :key="l"
            class="rounded-lg border px-2 py-1 text-xs"
            :class="state.layout === l ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
            @click="setLayout(l)"
          >
            {{ t(`public.${l}`) }}
          </button>
          <span class="ml-2 text-xs text-slate-500">{{ t('public.card') }}</span>
          <button
            v-for="tpl in ['simple', 'visual'] as const"
            :key="tpl"
            class="rounded-lg border px-2 py-1 text-xs"
            :class="state.template === tpl ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
            @click="setTemplate(tpl)"
          >
            {{ t(`public.${tpl}`) }}
          </button>
        </div>
      </div>

      <Loading v-if="!state.initialized && state.loading" />
      <EmptyState v-else-if="filteredAgents.length === 0" />

      <template v-else>
        <div v-if="state.layout === 'list'" class="space-y-2">
          <NodeRow v-for="agent in filteredAgents" :key="agent.id" :agent="agent" />
        </div>

        <template v-else>
          <div v-for="group in groupOrder(groupedAgents)" :key="group" class="mb-6">
            <h3 class="mb-3 text-sm font-semibold text-slate-400">{{ group }}</h3>
            <div class="grid gap-4" :class="cardSizeClass">
              <NodeCard
                v-for="agent in groupedAgents[group].filter((a) => filteredAgents.includes(a))"
                :key="agent.id"
                :agent="agent"
                :template="state.template"
                :size="(state.meta?.card_size as any) || 'comfortable'"
                :tag="customTag(agent.id)"
                :draggable="true"
                :class="{ 'opacity-50': dragOverId === agent.id && dragId !== agent.id }"
                @dragstart="onDragStart(agent, $event)"
                @dragend="onDragEnd"
                @dragover="onDragOver(agent, $event)"
                @drop="onDrop(agent, $event)"
              />
            </div>
          </div>
        </template>
      </template>
    </main>
  </div>
</template>
