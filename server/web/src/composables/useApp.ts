import { reactive, readonly, onMounted, computed } from 'vue';
import { publicApi } from '../services/publicApi';
import type { Agent, Overview, Sparklines, PublicMeta } from '../services/types';

export type PublicLayout = 'grid' | 'list' | 'compact';
export type CardTemplate = 'simple' | 'full';

export interface AppState {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  overview: Overview | null;
  agents: Agent[];
  sparklines: Sparklines;
  meta: PublicMeta | null;
  visitor: { ip: string; browser: string } | null;
  layout: PublicLayout;
  template: CardTemplate;
  search: string;
}

function getStoredLayout(): PublicLayout | null {
  const v = localStorage.getItem('diting-layout');
  if (v === 'grid' || v === 'list' || v === 'compact') return v;
  return null;
}

function getStoredTemplate(): CardTemplate | null {
  const v = localStorage.getItem('diting-template');
  if (v === 'simple' || v === 'full') return v;
  // 兼容旧值 'visual' → 'full'
  if (v === 'visual') return 'full';
  return null;
}

function defaultLayout(): PublicLayout {
  return 'grid';
}
function defaultTemplate(): CardTemplate {
  return 'simple';
}

function getStoredOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem('diting-order') || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function sortByOrder(list: Agent[], serverOrder: string[], localOrder: string[]): Agent[] {
  const order = localOrder.length ? localOrder : serverOrder;
  if (!order.length) return list;
  const m = new Map(order.map((id, i) => [id, i]));
  return [...list].sort((a, b) => {
    const ia = m.has(a.id) ? m.get(a.id)! : Infinity;
    const ib = m.has(b.id) ? m.get(b.id)! : Infinity;
    return ia - ib;
  });
}

export const state = reactive<AppState>({
  initialized: false,
  loading: false,
  error: null,
  overview: null,
  agents: [],
  sparklines: {},
  meta: null,
  visitor: null,
  layout: getStoredLayout() ?? defaultLayout(),
  template: getStoredTemplate() ?? defaultTemplate(),
  search: '',
});

let intervalId: ReturnType<typeof setInterval> | null = null;
// visibilitychange 监听只绑一次（useApp 会被多个组件调用）
let visibilityBound = false;
let serverOrder: string[] = [];
let localOrder: string[] = getStoredOrder();
// 用户是否在本地主动选择过布局（优先于服务端默认配置）
const userChoseLayout = localStorage.getItem('diting-layout') != null;

export const visibleAgents = computed<Agent[]>(() => {
  const q = state.search.trim().toLowerCase();
  let list = state.agents;
  if (q) {
    list = list.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.group || '').toLowerCase().includes(q) ||
        (a.hostname || '').toLowerCase().includes(q) ||
        (a.merchant || '').toLowerCase().includes(q) ||
        (a.country || '').toLowerCase().includes(q) ||
        (providerAlias(a.id, a.merchant).toLowerCase().includes(q)) ||
        (customTag(a.id) || '').toLowerCase().includes(q)
    );
  }
  return sortByOrder(list, serverOrder, localOrder);
});

// 厂商别名：meta.provider_aliases 覆盖原始 merchant 显示名
export function providerAlias(_agentId: string, merchant?: string): string {
  const aliases = state.meta?.provider_aliases || {};
  if (merchant && aliases[merchant]) return aliases[merchant];
  return merchant || '';
}

// 节点自定义标签：meta.custom_tags[agentId]
export function customTag(agentId: string): string {
  return (state.meta?.custom_tags && state.meta.custom_tags[agentId]) || '';
}

// 卡片方案：返回需要展示的总览 StatCard 字段集合
const CARD_SCHEMES: Record<string, string[]> = {
  official: ['online', 'total', 'cpu', 'mem', 'traffic', 'uptime'],
  basic: ['online', 'total', 'cpu', 'mem'],
  ops: ['online', 'offline', 'warn', 'cpu', 'mem', 'load', 'disk'],
  resource: ['cpu', 'mem', 'disk', 'net', 'swap', 'uptime'],
  finance: ['total', 'price', 'expire', 'quota'],
  traffic: ['traffic_total', 'rx_month', 'tx_month', 'net'],
  gpu: ['online', 'total', 'cpu', 'mem', 'gpu'],
  asset: ['total', 'groups', 'country', 'merchant'],
  full: ['online', 'total', 'cpu', 'mem', 'disk', 'net', 'traffic', 'uptime', 'price', 'expire', 'quota'],
};
export function cardSchemeKeys(): string[] {
  const scheme = (state.meta?.card_scheme as string) || 'official';
  return CARD_SCHEMES[scheme] || CARD_SCHEMES.official;
}

export const groupedAgents = computed<Record<string, Agent[]>>(() => {
  const groups: Record<string, Agent[]> = {};
  for (const a of visibleAgents.value) {
    const g = a.group || a.grp || '默认分组';
    if (!groups[g]) groups[g] = [];
    groups[g].push(a);
  }
  return groups;
});

// 并发保护：慢网络/大数据量下上一次 refresh 可能尚未完成，若不加锁，5s 轮询会不断叠加请求
//（实测页面停留期间累积 188 条请求）。进行中直接跳过本次，避免请求雪崩。
let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  state.loading = true;
  state.error = null;
  try {
    const needsSparklines = state.template === 'full';
    const [overview, agents, meta, sparklines] = await Promise.all([
      publicApi.overview(),
      publicApi.agents(),
      publicApi.meta(),
      needsSparklines ? publicApi.sparklines(undefined, '24h') : Promise.resolve({}),
    ]);
    state.overview = overview;
    state.agents = agents;
    state.meta = meta;
    state.sparklines = sparklines;
    serverOrder = meta?.agent_order || [];
    // B6: 后端 ui.home_layout 作为访客默认布局；用户本地选择优先
    if (!userChoseLayout && meta?.home_layout && (meta.home_layout === 'grid' || meta.home_layout === 'list' || meta.home_layout === 'compact')) {
      state.layout = meta.home_layout;
    }
    state.initialized = true;
  } catch (e) {
    state.error = (e as Error).message || '加载失败';
  } finally {
    state.loading = false;
    refreshing = false;
  }
}

export function setLayout(v: PublicLayout) {
  state.layout = v;
  localStorage.setItem('diting-layout', v);
}

export function setTemplate(v: CardTemplate) {
  state.template = v;
  localStorage.setItem('diting-template', v);
  refresh().catch(() => {});
}

export function setSearch(v: string) {
  state.search = v;
}

export function reorderAgents(ids: string[]) {
  localOrder = ids;
  try {
    localStorage.setItem('diting-order', JSON.stringify(ids));
  } catch {}
  // 管理员会话存在时同步到服务端（所有人可见固定顺序），否则仅本机固定
  publicApi.saveOrder(ids).catch(() => {});
}

export async function loadMeta() {
  try {
    const meta = await publicApi.meta();
    state.meta = meta;
    serverOrder = meta?.agent_order || [];
    if (meta?.visitor_info) {
      publicApi.visitor().then((v) => { state.visitor = v; }).catch(() => {});
    } else {
      state.visitor = null;
    }
  } catch {}
  return state.meta;
}

export function stopAutoRefresh() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}

// 暂停意图标志（与 useAdmin 同模式）：后台管理页不需要公开页的实时数据，
// 但 DashboardView 等仍会 useApp() 读 meta，其 onMounted 会启动轮询。
// 用 paused 标志而非直接 stop，避免子组件 onMounted 的 start 覆盖父组件的 stop。
let publicPaused = false;

// 进入/离开后台管理页时调用：暂停/恢复公开数据轮询。
export function setAutoRefreshPaused(p: boolean) {
  publicPaused = p;
  if (p) stopAutoRefresh();
}

// 轮询间隔：受控端上报间隔本身是 15s+，5s 刷新无实际收益却让 62 台规模下每 5s 拉一次
// overview+agents+meta（agents 列表不小），故放宽到 10s。
const REFRESH_INTERVAL_MS = 10000;

export function useApp() {
  onMounted(() => {
    if (!state.initialized) refresh();
    // 后台管理页（publicPaused=true）不轮询公开数据
    if (!intervalId && !publicPaused) intervalId = setInterval(refresh, REFRESH_INTERVAL_MS);
    // 页面切到后台/最小化时不轮询：用户看不见，请求纯属浪费（服务端也要为 62 台反复查库）。
    // 回到前台立刻补一次，保证数据是最新的。
    if (typeof document !== 'undefined' && !visibilityBound) {
      visibilityBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          refresh();
          // 后台管理页不重启轮询
          if (!intervalId && !publicPaused) intervalId = setInterval(refresh, REFRESH_INTERVAL_MS);
        } else if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      });
    }
  });

  return {
    state: readonly(state) as AppState,
    visibleAgents,
    groupedAgents,
    refresh,
    setLayout,
    setTemplate,
    setSearch,
    reorderAgents,
    providerAlias,
    customTag,
    cardSchemeKeys,
    stopAutoRefresh,
    setAutoRefreshPaused,
  };
}
