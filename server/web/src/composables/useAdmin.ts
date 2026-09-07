import { reactive, readonly } from 'vue';
import { adminApi } from '../services/adminApi';
import type { Agent, Settings } from '../services/types';

const REFRESH_INTERVAL_MS = 10000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
// 暂停采用「计数」而非布尔：任何未来出现「多个页面/弹层同时请求暂停」的场景
// （弹窗嵌入、嵌套 RouterView 等）都不会因某一方提前恢复而失效。
// 代价：onMounted(true) 必须与 onUnmounted(false) 严格配对，否则轮询会永久停摆
//（布尔版反而能自愈）——三个调用方（Settings/Template/AgentDetail）均已配对。
let pauseDepth = 0;

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
  if (refreshTimer || pauseDepth > 0) return;
  refreshTimer = setInterval(() => {
    if (pauseDepth > 0) return;
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
// 计数语义：p=true 深度 +1，p=false 深度 -1（下限 0），深度 >0 即暂停。
// 用计数而非直接 stop/start，避免父组件(AdminLayout) onMounted 的 start 覆盖子组件的 stop
// （Vue 中子组件 onMounted 先于父组件执行）。
export function setAutoRefreshPaused(p: boolean) {
  pauseDepth = Math.max(0, pauseDepth + (p ? 1 : -1));
  if (pauseDepth > 0) {
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
