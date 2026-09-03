import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
