import { api } from './api';
import type { Agent, Overview, Sparklines, Probes, PublicMeta } from './types';

function parseProbes(raw: unknown): Record<string, { ts: number; ms: number; ok: boolean; loss: number }[]> {
  if (raw && typeof raw !== 'object') {
    try {
      return JSON.parse(raw as string);
    } catch {
      return {};
    }
  }
  return (raw as Record<string, { ts: number; ms: number; ok: boolean; loss: number }[]>) || {};
}

export const publicApi = {
  overview: () => api.get<Overview>('/api/public/overview'),
  agents: async () => {
    const list = await api.get<Agent[]>('/api/public/agents');
    return list.map((a) => ({ ...a, probes: parseProbes(a.probes) }));
  },
  sparklines: () => api.get<Sparklines>('/api/public/agents/sparklines'),
  probes: (id: string) => api.get<Probes>(`/api/public/agents/${encodeURIComponent(id)}/probes`),
  meta: () => api.get<PublicMeta>('/api/public/meta'),
  saveOrder: (order: string[]) => api.post<{ ok: boolean }>('/api/public/order', { order }),
};
