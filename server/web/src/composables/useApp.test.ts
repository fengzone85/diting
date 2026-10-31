// useApp：公开页的全局状态、搜索/排序、布局模板持久化与轮询刷新。
// publicApi 全量 mock；每个用例 resetModules 拿到干净的模块级状态（serverOrder/localOrder 等）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Agent, PublicMeta } from '../services/types';

const apiMock = vi.hoisted(() => ({
  overview: vi.fn(),
  agents: vi.fn(),
  meta: vi.fn(),
  sparklines: vi.fn(),
  visitor: vi.fn(),
  saveOrder: vi.fn(),
}));

vi.mock('../services/publicApi', () => ({ publicApi: apiMock }));

function agent(id: string, extra: Record<string, unknown> = {}): Agent {
  return { id, name: id, ...extra } as unknown as Agent;
}

async function load() {
  return import('./useApp');
}

describe('useApp', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    vi.clearAllMocks();
    apiMock.overview.mockResolvedValue({});
    apiMock.agents.mockResolvedValue([]);
    apiMock.meta.mockResolvedValue({});
    apiMock.sparklines.mockResolvedValue({});
    apiMock.visitor.mockResolvedValue({ ip: '1.2.3.4', browser: 'x', ua: 'x' });
    apiMock.saveOrder.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('布局/模板从 localStorage 恢复，并兼容旧值 visual → full', async () => {
    localStorage.setItem('diting-layout', 'compact');
    localStorage.setItem('diting-template', 'visual');
    const { state } = await load();
    expect(state.layout).toBe('compact');
    expect(state.template).toBe('full');
  });

  it('非法存储值回退到默认 grid/simple', async () => {
    localStorage.setItem('diting-layout', 'nope');
    localStorage.setItem('diting-template', 'nope');
    const { state } = await load();
    expect(state.layout).toBe('grid');
    expect(state.template).toBe('simple');
  });

  it('providerAlias：命中别名 / 未命中原值 / 无 merchant 空串', async () => {
    const { state, providerAlias } = await load();
    state.meta = { provider_aliases: { 腾讯云: 'Tencent' } } as unknown as PublicMeta;
    expect(providerAlias('a', '腾讯云')).toBe('Tencent');
    expect(providerAlias('a', '阿里云')).toBe('阿里云');
    expect(providerAlias('a')).toBe('');
  });

  it('customTag：命中 / 未命中', async () => {
    const { state, customTag } = await load();
    state.meta = { custom_tags: { a: '生产' } } as unknown as PublicMeta;
    expect(customTag('a')).toBe('生产');
    expect(customTag('b')).toBe('');
  });

  it('cardSchemeKeys：已知方案 / 未知回退 official / 无 meta', async () => {
    const { state, cardSchemeKeys } = await load();
    state.meta = { card_scheme: 'ops' } as unknown as PublicMeta;
    expect(cardSchemeKeys()).toContain('offline');
    state.meta = { card_scheme: 'nope' } as unknown as PublicMeta;
    expect(cardSchemeKeys()).toEqual(['online_total', 'cpu', 'mem', 'traffic', 'instant_traffic']);
    state.meta = null;
    expect(cardSchemeKeys()).toEqual(['online_total', 'cpu', 'mem', 'traffic', 'instant_traffic']);
  });

  it('visibleAgents：空搜索返回全部，并按服务端顺序排序', async () => {
    const { state, visibleAgents, loadMeta } = await load();
    apiMock.meta.mockResolvedValue({ agent_order: ['b', 'a'] });
    await loadMeta();
    state.agents = [agent('a'), agent('b'), agent('c')];
    expect(visibleAgents.value.map((a) => a.id)).toEqual(['b', 'a', 'c']);
  });

  it('visibleAgents：搜索命中 name/group/hostname/merchant/country/别名/自定义标签', async () => {
    const { state, visibleAgents } = await load();
    state.meta = {
      provider_aliases: { 腾讯云: 'Tencent' },
      custom_tags: { a: 'k8s' },
    } as unknown as PublicMeta;
    state.agents = [
      agent('a', { name: 'alpha', group: 'g1', hostname: 'h1', merchant: '腾讯云', country: 'CN' }),
      agent('b', { name: 'beta', group: 'g2', hostname: 'h2', merchant: 'AWS', country: 'US' }),
    ];

    const ids = (q: string) => {
      state.search = q;
      return visibleAgents.value.map((x) => x.id);
    };
    expect(ids('alph')).toEqual(['a']);
    expect(ids('g2')).toEqual(['b']);
    expect(ids('h1')).toEqual(['a']);
    expect(ids('tencent')).toEqual(['a']);
    expect(ids('us')).toEqual(['b']);
    expect(ids('k8s')).toEqual(['a']);
    expect(ids('')).toEqual(['a', 'b']);
  });

  it('groupedAgents：按 group / grp / 默认分组归类', async () => {
    const { state, groupedAgents } = await load();
    state.agents = [
      agent('a', { group: 'g1' }),
      agent('b', { grp: 'g2' }),
      agent('c'),
    ];
    const groups = groupedAgents.value;
    expect(groups.g1.map((x) => x.id)).toEqual(['a']);
    expect(groups.g2.map((x) => x.id)).toEqual(['b']);
    expect(groups['默认分组'].map((x) => x.id)).toEqual(['c']);
  });

  it('setLayout / setTemplate / setSearch 写入状态与本地存储', async () => {
    const { state, setLayout, setTemplate, setSearch } = await load();
    setLayout('list');
    expect(state.layout).toBe('list');
    expect(localStorage.getItem('diting-layout')).toBe('list');

    setTemplate('full');
    expect(state.template).toBe('full');
    expect(localStorage.getItem('diting-template')).toBe('full');

    setSearch('abc');
    expect(state.search).toBe('abc');
  });

  it('setTemplate 切到 full 且 sparklines 为空时预热一次（in-flight 去重）', async () => {
    const { state, setTemplate } = await load();
    setTemplate('full');
    await Promise.resolve();
    await Promise.resolve();
    expect(apiMock.sparklines).toHaveBeenCalledTimes(1);
    expect(state.sparklines).toEqual({});
  });

  it('reorderAgents：持久化到 localStorage 并同步服务端', async () => {
    const { state, visibleAgents, reorderAgents } = await load();
    state.agents = [agent('a'), agent('b')];
    reorderAgents(['b', 'a']);
    expect(JSON.parse(localStorage.getItem('diting-order') || '[]')).toEqual(['b', 'a']);
    expect(apiMock.saveOrder).toHaveBeenCalledWith(['b', 'a']);
    expect(visibleAgents.value.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('loadMeta：visitor_info 存在时补拉 visitor，不存在时清空', async () => {
    const { state, loadMeta } = await load();
    apiMock.meta.mockResolvedValue({ visitor_info: true });
    await loadMeta();
    await Promise.resolve();
    expect(state.visitor).toEqual({ ip: '1.2.3.4', browser: 'x', ua: 'x' });

    apiMock.meta.mockResolvedValue({});
    state.visitor = { ip: 'x', browser: 'y' };
    await loadMeta();
    expect(state.visitor).toBeNull();
  });

  it('loadMeta：接口异常时吞掉并返回 null', async () => {
    const { state, loadMeta } = await load();
    apiMock.meta.mockRejectedValue(new Error('boom'));
    await expect(loadMeta()).resolves.toBeNull();
    expect(state.meta).toBeNull();
  });

  it('refresh：成功后写入 overview/agents/meta 并置 initialized', async () => {
    const { state, useApp } = await load();
    apiMock.overview.mockResolvedValue({ online: 1 });
    apiMock.agents.mockResolvedValue([agent('a')]);
    apiMock.meta.mockResolvedValue({ home_layout: 'list' });
    const { refresh } = useApp();
    await refresh();
    expect(state.overview).toEqual({ online: 1 });
    expect(state.agents).toHaveLength(1);
    expect(state.initialized).toBe(true);
    expect(state.layout).toBe('list');
  });

  it('refresh：失败时记录 error 且 loading 复位', async () => {
    const { state, useApp } = await load();
    apiMock.overview.mockRejectedValue(new Error('down'));
    const { refresh } = useApp();
    await refresh();
    expect(state.error).toBe('down');
    expect(state.loading).toBe(false);
  });

  it('refresh：并发调用只发一轮请求（refreshing 锁）', async () => {
    const { useApp } = await load();
    const { refresh } = useApp();
    await Promise.all([refresh(), refresh()]);
    expect(apiMock.overview).toHaveBeenCalledTimes(1);
  });

  it('refresh：full 模板会拉 sparklines', async () => {
    const { state, useApp } = await load();
    state.template = 'full';
    apiMock.sparklines.mockResolvedValue({ a: [] });
    const { refresh } = useApp();
    await refresh();
    expect(apiMock.sparklines).toHaveBeenCalledTimes(1);
    expect(state.sparklines).toEqual({ a: [] });
  });

  it('stopAutoRefresh / setAutoRefreshPaused 可安全重复调用', async () => {
    const { stopAutoRefresh, setAutoRefreshPaused } = await load();
    expect(() => {
      stopAutoRefresh();
      setAutoRefreshPaused(true);
      setAutoRefreshPaused(false);
      stopAutoRefresh();
    }).not.toThrow();
  });

  it('useApp() 挂载时触发首轮 refresh 并启动轮询，卸载后可停止', async () => {
    vi.useFakeTimers();
    const { createApp, defineComponent, h } = await import('vue');
    const { state, useApp } = await load();
    let api!: ReturnType<typeof useApp>;
    const Comp = defineComponent({
      setup() {
        api = useApp();
        return () => h('div');
      },
    });
    const app = createApp(Comp);
    app.mount(document.createElement('div'));
    await Promise.resolve();
    await Promise.resolve();
    expect(apiMock.overview).toHaveBeenCalledTimes(1);
    expect(state.initialized).toBe(true);

    await vi.advanceTimersByTimeAsync(10000);
    expect(apiMock.overview).toHaveBeenCalledTimes(2);

    api.stopAutoRefresh();
    await vi.advanceTimersByTimeAsync(30000);
    expect(apiMock.overview).toHaveBeenCalledTimes(2);
    app.unmount();
  });
});
