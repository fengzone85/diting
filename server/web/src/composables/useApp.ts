import { reactive, readonly, onMounted } from 'vue';
import { publicApi } from '../services/publicApi';
import type { Agent, Overview, Sparklines, PublicMeta } from '../services/types';

export interface AppState {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  overview: Overview | null;
  agents: Agent[];
  sparklines: Sparklines;
  meta: PublicMeta | null;
}

const state = reactive<AppState>({
  initialized: false,
  loading: false,
  error: null,
  overview: null,
  agents: [],
  sparklines: {},
  meta: null,
});

let intervalId: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  state.loading = true;
  state.error = null;
  try {
    const [overview, agents, sparklines, meta] = await Promise.all([
      publicApi.overview(),
      publicApi.agents(),
      publicApi.sparklines(),
      publicApi.meta(),
    ]);
    state.overview = overview;
    state.agents = agents;
    state.sparklines = sparklines;
    state.meta = meta;
    state.initialized = true;
  } catch (e) {
    state.error = (e as Error).message || '加载失败';
  } finally {
    state.loading = false;
  }
}

export function useApp() {
  onMounted(() => {
    if (!state.initialized) refresh();
    if (!intervalId) intervalId = setInterval(refresh, 5000);
  });

  return {
    state: readonly(state) as AppState,
    refresh,
  };
}
