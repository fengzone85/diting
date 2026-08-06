import { reactive, readonly, onMounted, computed } from 'vue';
import { publicApi } from '../services/publicApi';
import type { Agent, Overview, Sparklines, PublicMeta } from '../services/types';

export type PublicLayout = 'grid' | 'list' | 'compact';
export type CardTemplate = 'simple' | 'visual';

export interface AppState {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  overview: Overview | null;
  agents: Agent[];
  sparklines: Sparklines;
  meta: PublicMeta | null;
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
  if (v === 'simple' || v === 'visual') return v;
  return null;
}

function defaultLayout(): PublicLayout {
  return 'grid';
}
function defaultTemplate(): CardTemplate {
  return 'visual';
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

const state = reactive<AppState>({
  initialized: false,
  loading: false,
  error: null,
  overview: null,
  agents: [],
  sparklines: {},
  meta: null,
  layout: getStoredLayout() ?? defaultLayout(),
  template: getStoredTemplate() ?? defaultTemplate(),
  search: '',
});

let intervalId: ReturnType<typeof setInterval> | null = null;
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
        (a.country || '').toLowerCase().includes(q)
    );
  }
  return sortByOrder(list, serverOrder, localOrder);
});

export const groupedAgents = computed<Record<string, Agent[]>>(() => {
  const groups: Record<string, Agent[]> = {};
  for (const a of visibleAgents.value) {
    const g = a.group || a.grp || '默认分组';
    if (!groups[g]) groups[g] = [];
    groups[g].push(a);
  }
  return groups;
});

async function refresh() {
  state.loading = true;
  state.error = null;
  try {
    const needsSparklines = state.template === 'visual';
    const [overview, agents, meta, sparklines] = await Promise.all([
      publicApi.overview(),
      publicApi.agents(),
      publicApi.meta(),
      needsSparklines ? publicApi.sparklines() : Promise.resolve({}),
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

export function useApp() {
  onMounted(() => {
    if (!state.initialized) refresh();
    if (!intervalId) intervalId = setInterval(refresh, 5000);
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
  };
}
