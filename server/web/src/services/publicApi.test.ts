import { describe, it, expect, afterEach, vi } from 'vitest';
import { publicApi } from './publicApi';

describe('publicApi.agents probes normalization', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('parses probes from JSON string into an object', async () => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => [{ id: 'a1', name: 'n1', probes: '{"移动":[{"ts":1,"ms":10,"ok":true,"loss":0}]}' }] }) as Response
    );
    const list = await publicApi.agents();
    expect(list[0].probes).toBeTypeOf('object');
    expect(list[0].probes['移动']).toBeDefined();
    expect(Array.isArray(list[0].probes['移动'])).toBe(true);
  });

  it('keeps probes object when already an object', async () => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => [{ id: 'a1', name: 'n1', probes: { 电信: [] } }] }) as Response
    );
    const list = await publicApi.agents();
    expect(list[0].probes['电信']).toEqual([]);
  });

  it('falls back to empty object on invalid JSON', async () => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => [{ id: 'a1', name: 'n1', probes: 'not-json' }] }) as Response
    );
    const list = await publicApi.agents();
    expect(list[0].probes).toEqual({});
  });
});

describe('publicApi 查询参数拼接', () => {
  const realFetch = global.fetch;
  const seen: string[] = [];
  const mockFetch = () => {
    seen.length = 0;
    global.fetch = vi.fn(async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
  };
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sparklines：无参数 / 单参数 / 双参数', async () => {
    mockFetch();
    await publicApi.sparklines();
    await publicApi.sparklines('a1');
    await publicApi.sparklines('a1', '24h');
    expect(seen[0]).toBe('/api/public/agents/sparklines');
    expect(seen[1]).toBe('/api/public/agents/sparklines?id=a1');
    expect(seen[2]).toBe('/api/public/agents/sparklines?id=a1&range=24h');
  });

  it('probes：range 与 max_points 可选拼接', async () => {
    mockFetch();
    await publicApi.probes('a 1');
    await publicApi.probes('a1', '24h', 500);
    expect(seen[0]).toBe('/api/public/agents/a%201/probes');
    expect(seen[1]).toBe('/api/public/agents/a1/probes?range=24h&max_points=500');
  });

  it('meta / visitor / saveOrder 走对应端点', async () => {
    mockFetch();
    await publicApi.meta();
    await publicApi.visitor();
    await publicApi.saveOrder(['b', 'a']);
    expect(seen[0]).toBe('/api/public/meta');
    expect(seen[1]).toBe('/api/public/visitor');
    expect(seen[2]).toBe('/api/public/order');
  });
});
