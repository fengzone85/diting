import { api } from './api';
import type { Agent, Overview, Sparklines, Probes, PublicMeta } from './types';

export const publicApi = {
  overview: () => api.get<Overview>('/api/public/overview'),
  agents: () => api.get<Agent[]>('/api/public/agents'),
  sparklines: () => api.get<Sparklines>('/api/public/agents/sparklines'),
  probes: (id: string) => api.get<Probes>(`/api/public/agents/${encodeURIComponent(id)}/probes`),
  meta: () => api.get<PublicMeta>('/api/public/meta'),
  saveOrder: (order: string[]) => api.post<{ ok: boolean }>('/api/public/order', { order }),
};
