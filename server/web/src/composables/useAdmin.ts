import { reactive, readonly } from 'vue';
import { adminApi } from '../services/adminApi';
import type { Agent, Settings } from '../services/types';

const REFRESH_INTERVAL_MS = 10000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
// 暂停意图：设置页打开时置 true，无论 AdminLayout 何时 startAutoRefresh 都不真正轮询，
// 避免父组件 onMounted 的 start 覆盖子组件的 stop（子组件 onMounted 先于父执行）。
let paused = false;

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
  if (refreshTimer || paused) return;
  refreshTimer = setInterval(() => {
    if (paused) return;
    loadAdmin().catch(() => {});
  }, REFRESH_INTERVAL_MS);
}

export function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// 设置页进入/离开时调用：暂停/恢复自动刷新。
// 用 paused 标志而非直接 stop/start，避免父组件(AdminLayout) onMounted 的 start 覆盖子组件的 stop
// （Vue 中子组件 onMounted 先于父组件执行）。
export function setAutoRefreshPaused(p: boolean) {
  paused = p;
  if (p) {
    stopAutoRefresh();
  } else {
    startAutoRefresh();
  }
}

export function useAdmin() {
  return {
    state: readonly(state) as AdminState,
    refresh: loadAdmin,
    startAutoRefresh,
    stopAutoRefresh,
    setAutoRefreshPaused,
  };
}
