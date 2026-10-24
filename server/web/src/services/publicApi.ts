import { api } from './api';
import type { Agent, Overview, Sparklines, Probes, ProbesDetailed, PublicMeta } from './types';

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
  sparklines: (id?: string, range?: string) => {
    const params = new URLSearchParams();
    if (id) params.set('id', id);
    if (range) params.set('range', range);
    const qs = params.toString();
    return api.get<Sparklines>(`/api/public/agents/sparklines${qs ? `?${qs}` : ''}`);
  },
  probes: (id: string, range?: string, maxPoints?: number) =>
    api.get<Probes>(`/api/public/agents/${encodeURIComponent(id)}/probes${range ? `?range=${encodeURIComponent(range)}` : ''}${maxPoints ? `&max_points=${maxPoints}` : ''}`),
  // F4：一次请求同时拿延迟序列与可用率/证书元信息（详情页只在这里用）。
  probesDetailed: (id: string, range?: string, maxPoints?: number) => {
    const params = new URLSearchParams();
    if (range) params.set('range', range);
    if (maxPoints) params.set('max_points', String(maxPoints));
    params.set('availability', '1');
    return api.get<ProbesDetailed>(`/api/public/agents/${encodeURIComponent(id)}/probes?${params.toString()}`);
  },
  meta: () => api.get<PublicMeta>('/api/public/meta'),
  // 版本/构建时间/commit hash：页脚公开展示（2026-10-21 用户指定放开匿名完整版本）
  version: () => api.get<{
    version?: string;
    build_time?: string;
    hash?: string;
    data?: { version?: string; build_time?: string; hash?: string };
  }>('/api/version'),
  visitor: () => api.get<{ ip: string; browser: string; ua: string }>('/api/public/visitor'),
  saveOrder: (order: string[]) => api.post<{ ok: boolean }>('/api/public/order', { order }),
};
