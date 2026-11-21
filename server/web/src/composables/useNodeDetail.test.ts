// useNodeDetail：节点详情页数据层（时序历史/延迟探测/在线时段/自定义窗口）。
// publicApi 全量 mock；t 用「原样返回 key」的真实约定，便于验证错误文案分支。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp, computed, defineComponent, ref, type Ref } from 'vue';

const apiMock = vi.hoisted(() => ({
  sparklines: vi.fn(),
  probesDetailed: vi.fn(),
  onlineHistory: vi.fn(),
}));

vi.mock('../services/publicApi', () => ({ publicApi: apiMock }));
vi.mock('./useI18n', () => ({ t: (key: string) => key }));

import { useNodeDetail } from './useNodeDetail';
import type { Agent, OnlineHistory, ProbeAvailability, Probes } from '../services/types';

let app: ReturnType<typeof createApp> | null = null;
let agentId!: Ref<string>;
let agents!: Ref<Agent[]>;
let panel!: ReturnType<typeof useNodeDetail>;

function mountPanel(initialId = 'a1') {
  agentId = ref(initialId);
  // 两个节点：用于验证「切节点后旧响应不得写回」
  agents = ref([
    { id: 'a1', name: 'A1', cpu: 10, mem_pct: 20 },
    { id: 'a2', name: 'A2', cpu: 30, mem_pct: 40 },
  ]);
  const Comp = defineComponent({
    setup() {
      panel = useNodeDetail({
        agentId,
        agent: computed(() => agents.value.find((a) => a.id === agentId.value)),
      });
      return () => null;
    },
  });
  app = createApp(Comp);
  app.mount(document.createElement('div'));
}

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const onlineStub: OnlineHistory = {
  days: 30, since: 0, now: 1, daily: [], outages: [], uptime_pct: 99,
};

const seriesA: Probes = { 'a.example': [{ ts: 1, ms: 10, ok: true, loss: 0 }] };
const seriesB: Probes = { 'b.example': [{ ts: 2, ms: 20, ok: true, loss: 0 }] };
const avStub: ProbeAvailability = {
  up_pct: 99.9, samples: 10, down_samples: 0, avg_ms: 10, max_ms: 20,
  last_down_at: null, unreachable: false, type: 'tcp', code: null, cert_days: null, cert_ts: null,
};

describe('useNodeDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.sparklines.mockImplementation((id: string, range?: string) =>
      Promise.resolve(range === '30d'
        ? { [id]: [{ ts: 2, disk_used: 5, disk_total: 10 }] }
        : { [id]: [{ ts: 1, cpu: 10 }] })
    );
    apiMock.probesDetailed.mockResolvedValue({ series: seriesA, availability: { 'a.example': avStub } });
    apiMock.onlineHistory.mockResolvedValue(onlineStub);
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.useRealTimers();
  });

  it('挂载后拉取六图垫底、30d 基线、当前 range 延迟与在线时段', async () => {
    mountPanel();
    await flush();

    expect(apiMock.sparklines).toHaveBeenCalledWith('a1', '1h');
    expect(apiMock.sparklines).toHaveBeenCalledWith('a1', '30d');
    expect(apiMock.probesDetailed).toHaveBeenCalledWith('a1', '1h', 600, undefined);
    expect(apiMock.onlineHistory).toHaveBeenCalledWith('a1', 30);
    expect(panel.sparkRows30d.value).toHaveLength(1);
    expect(panel.probes.value).toEqual(seriesA);
    expect(panel.availability.value).toEqual({ 'a.example': avStub });
    expect(panel.online.value?.uptime_pct).toBe(99);
    expect(panel.loading.value).toBe(false);
    expect(panel.error.value).toBeNull();
  });

  it('切换节点时清空旧数据并按新 id 重载', async () => {
    mountPanel();
    await flush();
    expect(panel.probes.value).toEqual(seriesA);

    agentId.value = 'a2';
    await flush();

    expect(apiMock.onlineHistory).toHaveBeenLastCalledWith('a2', 30);
    expect(apiMock.sparklines).toHaveBeenCalledWith('a2', '30d');
    expect(panel.online.value?.uptime_pct).toBe(99);
    expect(panel.error.value).toBeNull();
  });

  it('实时启动请求未返回时被 stopRealtime 停止：不写数据、不留轮询定时器', async () => {
    vi.useFakeTimers();
    const first = deferred<Record<string, { ts: number }[]>>();
    apiMock.sparklines.mockReturnValueOnce(first.promise); // 首次 1h 垫底挂起
    mountPanel();

    // 请求还在飞行中就被外部停掉（历史事故：恢复后仍启动定时器）
    panel.stopRealtime();
    first.resolve({ a1: [{ ts: 1 }] });
    await flush();

    expect(panel.rtRows.value).toEqual([]);
    // 若定时器被错误启动，10s 后会追加快照点
    vi.advanceTimersByTime(25000);
    expect(panel.rtRows.value).toEqual([]);
  });

  it('组件卸载后未返回的响应不写状态', async () => {
    const first = deferred<Record<string, { ts: number }[]>>();
    apiMock.sparklines.mockReturnValueOnce(first.promise);
    mountPanel();

    app?.unmount();
    app = null;
    first.resolve({ a1: [{ ts: 1 }] });
    await flush();

    expect(panel.rtRows.value).toEqual([]);
    expect(panel.loading.value).toBe(false);
    expect(panel.error.value).toBeNull();
  });

  it('自定义区间：非法与超 30 天被前端拦下，合法窗口按 custom 参数请求', async () => {
    mountPanel();
    await flush();

    panel.openCustom('chart');
    panel.customStart.value = '2026-01-02T00:00';
    panel.customEnd.value = '2026-01-01T00:00';
    await panel.applyCustom();
    expect(panel.error.value).toBe('node.custom.invalid');
    expect(panel.customOpen.value).toBe(true);

    panel.customStart.value = '2026-01-01T00:00';
    panel.customEnd.value = '2026-03-15T00:00';
    await panel.applyCustom();
    expect(panel.error.value).toBe('node.custom.tooLarge');

    panel.customStart.value = '2026-01-01T00:00';
    panel.customEnd.value = '2026-01-02T00:00';
    await panel.applyCustom();
    expect(panel.chartRange.value).toBe('custom');
    expect(panel.customOpen.value).toBe(false);
    expect(apiMock.sparklines).toHaveBeenCalledWith('a1', undefined, {
      start: new Date('2026-01-01T00:00').toISOString(),
      end: new Date('2026-01-02T00:00').toISOString(),
    });
  });

  it('范围切换竞态：后发的请求先返回时，过期的旧响应被丢弃', async () => {
    const slow = deferred<{ series: Probes; availability: Record<string, ProbeAvailability> }>();
    const fast = deferred<{ series: Probes; availability: Record<string, ProbeAvailability> }>();
    apiMock.probesDetailed
      .mockReturnValueOnce(slow.promise)  // 挂载时的 1h
      .mockReturnValueOnce(fast.promise); // 切换后的 6h
    mountPanel();
    await flush();

    // 切到 6h（第二次请求），先返回
    panel.switchRange('6h');
    fast.resolve({ series: seriesB, availability: {} });
    await flush();
    expect(panel.probes.value).toEqual(seriesB);

    // 1h 的旧响应后到，不得覆盖
    slow.resolve({ series: seriesA, availability: { 'a.example': avStub } });
    await flush();
    expect(panel.probes.value).toEqual(seriesB);
    expect(panel.currentRange.value).toBe('6h');
  });
});
