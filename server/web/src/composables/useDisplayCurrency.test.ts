// 显示币种（访客侧纯展示偏好）：本地存储持久化、可用性回退、符号兜底与金额换算。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  overview: vi.fn(),
  agents: vi.fn(),
  meta: vi.fn(),
  sparklines: vi.fn(),
  visitor: vi.fn(),
  saveOrder: vi.fn(),
}));

vi.mock('../services/publicApi', () => ({ publicApi: apiMock }));

type Billing = Record<string, unknown>;

function billingOf(partial: Billing): Billing {
  return {
    base_currency_code: 'CNY',
    base_currency: 'CNY',
    base_symbol: '¥',
    by_currency: {},
    display_rates: {},
    ...partial,
  };
}

async function load(billing?: Billing, opts: { stored?: string } = {}) {
  vi.resetModules();
  localStorage.clear();
  if (opts.stored) localStorage.setItem('diting.display_currency', opts.stored);
  const { state } = await import('./useApp');
  state.overview = (billing ? { billing: billingOf(billing) } : null) as never;
  return import('./useDisplayCurrency');
}

describe('useDisplayCurrency', () => {
  beforeEach(() => {
    apiMock.meta.mockResolvedValue({});
    apiMock.overview.mockResolvedValue({});
    apiMock.agents.mockResolvedValue([]);
    apiMock.sparklines.mockResolvedValue({});
    apiMock.visitor.mockResolvedValue({});
    apiMock.saveOrder.mockResolvedValue({ ok: true });
  });

  it('初始偏好读本地存储，不可读时退空', async () => {
    const mod = await load({ display_rates: { USD: 0.14 } }, { stored: 'USD' });
    expect(mod.useDisplayCurrency().code.value).toBe('USD');

    // 只让 display_currency 这个键抛错（useApp 自身的本地存储读取不能被波及）
    const orig = Storage.prototype.getItem;
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === 'diting.display_currency') throw new Error('blocked');
      return orig.call(this, key);
    });
    try {
      const mod2 = await load();
      expect(mod2.useDisplayCurrency().code.value).toBe('');
    } finally {
      getItem.mockRestore();
    }
  });

  it('无账单数据：无选项、空币种符号、金额原样返回', async () => {
    const { useDisplayCurrency } = await load();
    const d = useDisplayCurrency();
    expect(d.options.value).toEqual([]);
    expect(d.activeCode.value).toBe('');
    expect(d.symbol.value).toBe('');
    expect(d.amount(12.5)).toBe(12.5);

    const mod = await load({ base_currency_code: '' });
    const d2 = mod.useDisplayCurrency();
    expect(d2.activeCode.value).toBe('');
    expect(d2.amount(3)).toBe(3);
  });

  it('选项只列有换算率的币种，基币置顶，缺符号时用代码兜底', async () => {
    const { useDisplayCurrency } = await load({
      by_currency: { CNY: { symbol: '¥' }, USD: { symbol: '$' }, JPY: {} },
      display_rates: { CNY: 1, USD: 0.14, JPY: 20.5 },
    });
    const d = useDisplayCurrency();
    const codes = d.options.value.map((o: { code: string }) => o.code);
    expect(codes[0]).toBe('CNY');
    expect(new Set(codes)).toEqual(new Set(['CNY', 'JPY', 'USD']));
    const jpy = d.options.value.find((o: { code: string }) => o.code === 'JPY');
    expect(jpy.symbol).toBe('JPY');
  });

  it('有效币种：偏好有汇率时生效，汇率被清后回退基币', async () => {
    const { useDisplayCurrency } = await load({
      by_currency: { USD: { symbol: '$' } },
      display_rates: { USD: 0.14 },
    });
    const d = useDisplayCurrency();
    d.setCode('USD');
    expect(d.activeCode.value).toBe('USD');
    expect(d.symbol.value).toBe('$');

    const { state } = await import('./useApp');
    state.overview = { billing: billingOf({ display_rates: {} }) } as never;
    expect(d.activeCode.value).toBe('CNY');
    expect(d.symbol.value).toBe('¥');
  });

  it('符号回退链：by_currency 符号 → base_symbol → base_currency', async () => {
    const { useDisplayCurrency } = await load({ by_currency: {}, base_symbol: '¥', display_rates: { CNY: 1 } });
    expect(useDisplayCurrency().symbol.value).toBe('¥');

    const mod = await load({ by_currency: {}, base_symbol: '', display_rates: { CNY: 1 } });
    expect(mod.useDisplayCurrency().symbol.value).toBe('CNY');
  });

  it('setCode 写入/清除本地存储，写入失败静默不抛', async () => {
    const { useDisplayCurrency } = await load({ display_rates: { CNY: 1, USD: 0.14 } });
    const d = useDisplayCurrency();
    d.setCode('USD');
    expect(localStorage.getItem('diting.display_currency')).toBe('USD');
    d.setCode('');
    expect(localStorage.getItem('diting.display_currency')).toBeNull();

    const origSet = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'diting.display_currency') throw new Error('quota');
      return origSet.call(this, key, value);
    });
    try {
      expect(() => d.setCode('USD')).not.toThrow();
      expect(d.code.value).toBe('USD');
    } finally {
      setItem.mockRestore();
    }
  });

  it('金额换算：同币种原值，跨币种按汇率乘算', async () => {
    const { useDisplayCurrency } = await load({
      by_currency: { USD: { symbol: '$' } },
      display_rates: { USD: 0.14 },
    });
    const d = useDisplayCurrency();
    expect(d.amount(100)).toBe(100);
    d.setCode('USD');
    expect(d.amount(100)).toBeCloseTo(14);
  });
});
