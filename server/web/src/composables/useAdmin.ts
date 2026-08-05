import { reactive, readonly } from 'vue';
import { adminApi } from '../services/adminApi';
import type { Agent, Settings, User, Alert } from '../services/types';

export interface AdminState {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  agents: Agent[];
  settings: Settings | null;
  users: User[];
  alerts: Alert[];
  overview: Record<string, unknown> | null;
}

const state = reactive<AdminState>({
  initialized: false,
  loading: false,
  error: null,
  agents: [],
  settings: null,
  users: [],
  alerts: [],
  overview: null,
});

export async function loadAdmin() {
  state.loading = true;
  state.error = null;
  try {
    const [agents, settings, users, alerts, overview] = await Promise.all([
      adminApi.listAgents(),
      adminApi.getSettings(),
      adminApi.listUsers().catch(() => [] as User[]),
      adminApi.listAlerts().catch(() => [] as Alert[]),
      adminApi.overview(),
    ]);
    state.agents = agents;
    state.settings = settings;
    state.users = users;
    state.alerts = alerts;
    state.overview = overview;
    state.initialized = true;
  } catch (e) {
    state.error = (e as Error).message || '加载失败';
  } finally {
    state.loading = false;
  }
}

export function useAdmin() {
  return {
    state: readonly(state) as AdminState,
    refresh: loadAdmin,
  };
}
