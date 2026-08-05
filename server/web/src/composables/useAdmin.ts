import { reactive, readonly } from 'vue';
import { adminApi } from '../services/adminApi';
import type { Agent, Settings } from '../services/types';

const REFRESH_INTERVAL_MS = 10000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export interface AdminState {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  agents: Agent[];
  settings: Settings | null;
  overview: Record<string, unknown> | null;
}

const state = reactive<AdminState>({
  initialized: false,
  loading: false,
  error: null,
  agents: [],
  settings: null,
  overview: null,
});

export async function loadAdmin() {
  state.loading = true;
  state.error = null;
  try {
    const [agents, settings, overview] = await Promise.all([
      adminApi.listAgents(),
      adminApi.getSettings(),
      adminApi.overview(),
    ]);
    state.agents = agents;
    state.settings = settings;
    state.overview = overview;
    state.initialized = true;
  } catch (e) {
    state.error = (e as Error).message || '加载失败';
  } finally {
    state.loading = false;
  }
}

export function startAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    loadAdmin().catch(() => {});
  }, REFRESH_INTERVAL_MS);
}

export function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function useAdmin() {
  return {
    state: readonly(state) as AdminState,
    refresh: loadAdmin,
  };
}
