<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue';
import AppHeader from '../components/AppHeader.vue';
import NodeCard from '../components/NodeCard.vue';
import NodeCardSimple from '../components/NodeCardSimple.vue';
import NodeRow from '../components/NodeRow.vue';
import StatCard from '../components/ui/StatCard.vue';
import Loading from '../components/ui/Loading.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import ErrorMessage from '../components/ui/ErrorMessage.vue';
import { useApp, cardSchemeKeys, customTag } from '../composables/useApp';
import { useI18n } from '../composables/useI18n';
import type { Agent } from '../services/types';
import {
  GridFour, ListTwo, LayoutOne, LayoutFour, ApplicationMenu, GridTwo, Search,
} from '@icon-park/vue-next';

const { state, visibleAgents, groupedAgents, setLayout, setTemplate, setSearch, reorderAgents } = useApp();
const { t } = useI18n();

const searchInput = ref(state.search);
watch(searchInput, (v) => setSearch(v));

// 可展开搜索框（2026-10-12）：图标按钮 toggle；展开自动聚焦，收起清空
// （避免列表仍被过滤而看不出原因；有搜索词时图标保持高亮提示）。
const searchOpen = ref(!!state.search);
const searchEl = ref<HTMLInputElement | null>(null);
function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (searchOpen.value) {
    nextTick(() => searchEl.value?.focus());
  } else {
    searchInput.value = '';
  }
}

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

// 卡片尺寸 → 网格列数（2026-10-21：档位此前在 ≥1280px 下 3/4 名同列数，现改为 3/4/5/6 递进）
const cardSizeClass = computed(() => {
  const size = (state.meta?.card_size as string) || 'comfortable';
  return {
    'grid-cols-1 md:grid-cols-2 lg:grid-cols-3': size === 'large',
    'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4': size === 'comfortable',
    'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5': size === 'compact',
    'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6': size === 'mini',
  };
});

// 卡片单卡最大宽度也随档位变化：卡片组件里写死的 max-width:330/360px 会让
// large 档在 ≥1280px 下只比 comfortable 宽一点点，并在单元格右侧留白。
const cardMaxWidth = computed(() => {
  const size = (state.meta?.card_size as string) || 'comfortable';
  const map: Record<string, string> = { mini: '340px', compact: '380px', comfortable: '420px', large: '520px' };
  return map[size] || map.comfortable;
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
  // 总即时流量：所有节点当前实时速率，下行/上行分开统计
  const totalRxRate = sum((a) => a.net_rx_rate || 0);
  const totalTxRate = sum((a) => a.net_tx_rate || 0);
  // 紧凑速率文案（无空格、单位缩写）：如 "1.2M/s"、"340K/s"、"0B/s"
  const rateText = (n: number) => `${fmtRateCompact(n)}/s`;
  // 实时速率卡（2026-10-21 用户指定）：上行主行 + 下行副行，与「流量概览」的上下顺序一致。
  // official 方案的「实时速率」与 traffic 方案的「实时速率」共用同一份数据。
  const liveTraffic = {
    value: `↑${rateText(totalTxRate)}`,
    sub: `↓${rateText(totalRxRate)}`,
    compact: true,
    spread: true,
    // 数值大的一行加粗：下行速率更大时副行加粗
    boldSub: totalRxRate > totalTxRate,
    variant: 'default' as const,
  };
  // 流量配额（finance 方案）：各节点月配额汇总 vs 本月已用流量（下行+上行）
  const totalQuotaGb = sum((a) => a.monthly_quota_gb || 0);
  const trafficUsed = totalRx + totalTx;
  const quotaBytes = totalQuotaGb * 1024 ** 3;
  const quotaPct = quotaBytes > 0 ? (trafficUsed / quotaBytes) * 100 : 0;
  const usedText = trafficUsed > 0 ? fmtBytes(trafficUsed) : '0B';
  // 月度费用（价格口径对齐 Komari）：>0 求和显示；全为 -1（免费）显示「免费」；
  // 全为 0（未填写，不显示）则显示 '—'。
  const priced = ags.filter((a) => typeof a.price === 'number');
  const paidTotal = priced.reduce((s, a) => s + (a.price! > 0 ? a.price! : 0), 0);
  const anyFree = priced.some((a) => a.price! < 0);
  const costCurrency = priced.find((a) => a.price! > 0)?.currency || '¥';
  const monthlyCostText = paidTotal > 0 ? `${costCurrency}${paidTotal.toFixed(2)}` : (anyFree ? t('public.free') : '—');
  // 剩余价值（Komari 资产统计口径）：各节点服务端折算值之和；总价值 = 正价之和
  const remainingTotal = ags.reduce((s, a) => s + (typeof a.remaining_value === 'number' ? a.remaining_value : 0), 0);
  const assetTotalText = paidTotal > 0 ? `${costCurrency}${paidTotal.toFixed(2)}` : '—';
  const remainingText = remainingTotal > 0 ? `${costCurrency}${remainingTotal.toFixed(2)}` : (anyFree ? t('public.free') : '—');
  // 平均系统负载（ops 方案）：仅统计有 load1 上报的节点
  const loadValues = ags.map((a) => a.load1).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const avgLoad = loadValues.length ? loadValues.reduce((s, v) => s + v, 0) / loadValues.length : null;
  const map: Record<string, { label: string; value: string; sub?: string; compact?: boolean; subBig?: boolean; spread?: boolean; boldSub?: boolean; variant: 'default' | 'success' | 'danger' | 'warning' }> = {
    online: { label: t('public.online'), value: String(o?.online ?? '-'), variant: 'success' },
    offline: { label: t('public.offline'), value: String(o?.offline ?? '-'), variant: 'danger' },
    warn: { label: t('public.highLoad'), value: String(highLoad), variant: 'warning' },
    total: { label: t('public.totalAgents'), value: String(o?.total ?? '-'), variant: 'default' },
    cpu: { label: t('public.avgCpu'), value: o?.cpu_avg != null ? `${o.cpu_avg.toFixed(1)}%` : '-', variant: 'warning' },
    mem: { label: t('public.avgMem'), value: o?.mem_avg != null ? `${o.mem_avg.toFixed(1)}%` : '-', variant: 'default' },
    // 「系统负载」≠「高负载节点数」：原先与 warn 共用 highLoad 计数和同一个
    // i18n 文案，导致 ops 方案里出现两张一模一样的「高负载」卡。
    // 这里改为各节点 load1 的均值。
    load: { label: t('public.avgLoad'), value: avgLoad != null ? avgLoad.toFixed(2) : '-', variant: 'default' },
    disk: { label: t('public.diskUsage'), value: '-', variant: 'default' },
    net: { label: t('public.netRate'), ...liveTraffic },
    swap: { label: t('public.swap'), value: '-', variant: 'default' },
    // 总即时流量（2026-10-12 用户指定）：替换原「运行时间(uptime)」占位卡
    // （其 value 一直是 '-' 未实现）。下行主行 + 上行副行；空闲显示 0 B/s 而非 '-'。
    instant_traffic: { label: t('public.instantTraffic'), ...liveTraffic },
    // 当前在线（2026-10-21 用户指定）：合并原「在线」+「受控端总数」两张卡，值为 在线 / 总数
    online_total: {
      label: t('public.currentOnline'),
      value: `${o?.online ?? '-'} / ${o?.total ?? '-'}`,
      variant: 'success',
    },
    // 流量概览（2026-10-21 用户指定）：原「TFC」卡改为双排显示本月上行/下行
    // spread：上行贴标题、下行贴卡底，两行在卡内上下分布
    traffic: {
      label: t('public.trafficOverview'),
      value: `↑ ${fmtTraffic(totalTx)}`,
      sub: `↓ ${fmtTraffic(totalRx)}`,
      compact: true,
      spread: true,
      // 数值大的一行加粗：下行累计更大时副行加粗
      boldSub: totalRx > totalTx,
      variant: 'default',
    },
    traffic_total: { label: t('public.trafficTotal'), value: fmtBytes(totalRx + totalTx), variant: 'default' },
    rx_month: { label: t('public.rxMonth'), value: fmtBytes(totalRx), variant: 'default' },
    tx_month: { label: t('public.txMonth'), value: fmtBytes(totalTx), variant: 'default' },
    price: { label: t('public.monthlyCost'), value: monthlyCostText, variant: 'default' },
    remaining: {
      label: t('public.remainingValue'),
      value: remainingText,
      sub: `${t('public.totalValue')} ${assetTotalText}`,
      variant: 'success',
    },
    expire: { label: t('public.expiring'), value: String(expiring), variant: 'warning' },
    // 流量配额（2026-10-21）：原为写死 '-'。有配额时主值显示使用率、
    // 副行显示「已用 / 配额」；未配置配额（全为 0）时显示已用量 + ∞。
    quota: totalQuotaGb > 0
      ? {
          label: t('public.quota'),
          value: `${quotaPct.toFixed(1)}%`,
          sub: `${usedText} / ${fmtBytes(quotaBytes)}`,
          variant: quotaPct >= 90 ? 'danger' : quotaPct >= 75 ? 'warning' : 'default',
        }
      : { label: t('public.quota'), value: usedText, sub: `/ ∞`, variant: 'default' },
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
// 流量概览卡专用：保留两位小数（如 "4.12 GB"），与总览其余卡片的整数位口径区分
function fmtTraffic(n: number): string {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${u[i]}`;
}
// 紧凑速率格式（总即时流量卡专用）：无空格、单位缩写——如 "1.2M"、"340K"、"0B"
function fmtRateCompact(n: number): string {
  if (!n || n <= 0) return '0B';
  const u = ['B', 'K', 'M', 'G', 'T', 'P'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)}${u[i]}`;
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

// 列表模式形态：横排 1 列（全列宽行）/ 横排 2 列（精简行，2xl 屏并排两列）
const listCols = ref<1 | 2>(localStorage.getItem('diting-list-cols') === '2' ? 2 : 1);
function setListCols(n: 1 | 2) {
  listCols.value = n;
  localStorage.setItem('diting-list-cols', String(n));
}

// 布局控制栏（2026-10-12 图标化 + 对齐 Komari 精简）：去掉文字标签，按钮仅图标；
// compact 布局按钮已移除——其渲染与 grid 完全相同（cardSizeClass 只读 meta.card_size，
// 与 layout 无关），属与实现脱钩的死按钮。state.layout 类型保留 'compact' 兼容存量配置。
const LAYOUT_OPTS = [
  { key: 'grid' as const, icon: GridFour, label: 'public.grid' },
  { key: 'list' as const, icon: ListTwo, label: 'public.list' },
];
const TEMPLATE_OPTS = [
  { key: 'simple' as const, icon: LayoutOne, label: 'public.card_simple' },
  { key: 'full' as const, icon: LayoutFour, label: 'public.card_full' },
];
const COLS_OPTS = [
  { key: 1 as const, icon: ApplicationMenu, label: 'public.cols1' },
  { key: 2 as const, icon: GridTwo, label: 'public.cols2' },
];
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
    <!-- 列表·横排 2 列在统一 max-w-7xl 容器内适配（用户要求：不改网页宽度）：
         2xl 视口下内容区 1232px，双列每列 612px、扣行内边距后可用 ~592px；
         dense 列集已压至 ~562px（固定/弹性最小 514 + gaps 48），由列集压缩
         而非放宽容器保证不溢出（余量 ~30px） -->
    <main class="mx-auto max-w-7xl px-4 pt-4 sm:px-6">
      <ErrorMessage v-if="state.error" class="mb-6" :message="state.error" />

      <!-- 总览卡片：列数随卡片数量自适应（合并卡片后不再固定 6 列留空格） -->
      <div class="mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 sm:gap-4">
        <StatCard
          v-for="(c, i) in overviewCards.items"
          :key="i"
          size="sm"
          :label="c.label"
          :value="c.value"
          :sub="c.sub"
          :compact="c.compact"
          :sub-big="c.subBig"
          :spread="c.spread"
          :bold-sub="c.boldSub"
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
          <!-- 搜索：图标按钮（点击展开/收起输入框，Esc 收起） -->
          <button
            class="flex h-7 w-7 items-center justify-center rounded-lg border"
            :class="searchOpen || searchInput ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
            :title="t('public.search')"
            @click="toggleSearch"
          >
            <Search :size="16" />
          </button>
          <input
            v-if="searchOpen"
            ref="searchEl"
            v-model="searchInput"
            :placeholder="t('public.searchPlaceholder')"
            class="h-7 rounded-lg border border-slate-700 bg-slate-900/50 px-2.5 text-xs text-white outline-none focus:border-sky-500 sm:w-52"
            @keydown.esc="toggleSearch"
          />
          <span class="whitespace-nowrap text-xs text-slate-500">{{ t('public.nodeCount', { n: filteredAgents.length }) }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <!-- 布局：网格 / 列表 / 紧凑（图标控制，hover 显示名称） -->
          <button
            v-for="o in LAYOUT_OPTS"
            :key="o.key"
            class="flex h-7 w-7 items-center justify-center rounded-lg border"
            :class="state.layout === o.key ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
            :title="t(o.label)"
            @click="setLayout(o.key)"
          >
            <component :is="o.icon" :size="16" />
          </button>
          <span class="mx-1 h-4 w-px bg-slate-700"></span>
          <!-- 卡片模板：简约 / 完整 -->
          <button
            v-for="o in TEMPLATE_OPTS"
            :key="o.key"
            class="flex h-7 w-7 items-center justify-center rounded-lg border"
            :class="state.template === o.key ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
            :title="t(o.label)"
            @click="setTemplate(o.key)"
          >
            <component :is="o.icon" :size="16" />
          </button>
          <!-- 列表模式专属：横排 1 列 / 2 列 形态切换 -->
          <template v-if="state.layout === 'list'">
            <span class="mx-1 h-4 w-px bg-slate-700"></span>
            <button
              v-for="o in COLS_OPTS"
              :key="o.key"
              class="flex h-7 w-7 items-center justify-center rounded-lg border"
              :class="listCols === o.key ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
              :title="t(o.label)"
              @click="setListCols(o.key)"
            >
              <component :is="o.icon" :size="16" />
            </button>
          </template>
        </div>
      </div>

      <Loading v-if="!state.initialized && state.loading" />
      <EmptyState v-else-if="filteredAgents.length === 0" />

      <template v-else>
        <div
          v-if="state.layout === 'list'"
          class="grid grid-cols-1 gap-2"
          :class="listCols === 2 ? '2xl:grid-cols-2' : ''"
        >
          <NodeRow v-for="agent in filteredAgents" :key="agent.id" :agent="agent" :dense="listCols === 2" />
        </div>

        <template v-else>
          <div v-for="group in groupOrder(groupedAgents)" :key="group" class="mb-6">
            <h3 class="mb-3 text-sm font-semibold text-slate-400">{{ group }}</h3>
            <!-- 简约卡片（默认） -->
            <div v-if="state.template === 'simple'" class="grid gap-3" :class="cardSizeClass" :style="{ '--card-max': cardMaxWidth }">
              <NodeCardSimple
                v-for="agent in groupedAgents[group].filter((a) => filteredAgents.includes(a))"
                :key="agent.id"
                :agent="agent"
                :tag="customTag(agent.id)"
                :draggable="true"
                :class="{ 'opacity-50': dragOverId === agent.id && dragId !== agent.id }"
                @dragstart="onDragStart(agent, $event)"
                @dragend="onDragEnd"
                @dragover="onDragOver(agent, $event)"
                @drop="onDrop(agent, $event)"
              />
            </div>
            <!-- 完整卡片 -->
            <div v-else class="grid gap-3" :class="cardSizeClass" :style="{ '--card-max': cardMaxWidth }">
              <NodeCard
                v-for="agent in groupedAgents[group].filter((a) => filteredAgents.includes(a))"
                :key="agent.id"
                :agent="agent"
                :template="'full'"
                :size="(state.meta?.card_size as any) || 'comfortable'"
                :tag="customTag(agent.id)"
                :sparklines="state.sparklines"
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
