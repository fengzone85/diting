import { api } from './api';
import type { Agent, Overview, Sparklines, Probes, PublicMeta } from './types';

// agent 快照的 probes 是 JSON 字符串 `{"目标":{ts,ms,ok,loss}}`（单对象），解析后返回对象形态
function parseProbes(raw: unknown): Record<string, { ts?: number; ms?: number; ok?: boolean; loss?: number }> {
  if (raw && typeof raw !== 'object') {
    try {
      return JSON.parse(raw as string);
    } catch {
      return {};
    }
  }
  return (raw as Record<string, { ts?: number; ms?: number; ok?: boolean; loss?: number }>) || {};
}

export const publicApi = {
  overview: () => api.get<Overview>('/api/public/overview'),
  agents: async () => {
    const list = await api.get<Agent[]>('/api/public/agents');
    return list.map((a) => ({ ...a, probes: parseProbes(a.probes) }));
  },
  sparklines: (id?: string, range?: string) =>
    api.get<Sparklines>(`/api/public/agents/sparklines${id ? `?id=${encodeURIComponent(id)}` : ''}${id && range ? `&range=${encodeURIComponent(range)}` : ''}`),
  probes: (id: string, range?: string) =>
    api.get<Probes>(`/api/public/agents/${encodeURIComponent(id)}/probes${range ? `?range=${encodeURIComponent(range)}` : ''}`),
  meta: () => api.get<PublicMeta>('/api/public/meta'),
  visitor: () => api.get<{ ip: string; browser: string; ua: string }>('/api/public/visitor'),
  saveOrder: (order: string[]) => api.post<{ ok: boolean }>('/api/public/order', { order }),
};
