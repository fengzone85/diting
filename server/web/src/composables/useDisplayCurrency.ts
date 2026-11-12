import { computed, ref } from 'vue';
import { useApp } from './useApp';
import type { BillingSummary, Overview } from '../services/types';

// 访客侧「显示币种」：纯展示偏好，存 localStorage，不改服务端计算口径，
// 也不影响告警/资产统计（那些始终以标准货币为准）。
const STORAGE_KEY = 'diting.display_currency';

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

const code = ref<string>(readStored());

export function useDisplayCurrency() {
  const app = useApp();

  const billing = computed<BillingSummary | undefined>(() => {
    const overview = app.state.overview as Overview | null;
    return overview?.billing;
  });

  // 可切换的币种：只列服务端给出了换算率的（缺汇率的币种没有值，列出来会显示错数）
  const options = computed(() => {
    const rates = billing.value?.display_rates || {};
    return Object.keys(rates)
      .map((c) => ({ code: c, symbol: billing.value?.by_currency[c]?.symbol || c }))
      .sort((a, b) => (a.code === billing.value?.base_currency_code ? -1 : b.code === billing.value?.base_currency_code ? 1 : a.code.localeCompare(b.code)));
  });

  // 有效展示币种：偏好已不可用（汇率被清空）时回退标准币
  const activeCode = computed(() => {
    const base = billing.value?.base_currency_code;
    if (!base) return '';
    return code.value && billing.value?.display_rates?.[code.value] ? code.value : base;
  });

  const symbol = computed(() => {
    const b = billing.value;
    if (!b) return '';
    return b.by_currency[activeCode.value]?.symbol || b.base_symbol || b.base_currency;
  });

  function setCode(v: string) {
    code.value = v;
    try {
      if (v) localStorage.setItem(STORAGE_KEY, v);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 隐私模式下 localStorage 不可写，忽略 */
    }
  }

  // 标准币金额 → 当前展示币种金额
  function amount(baseAmount: number): number {
    const b = billing.value;
    const base = b?.base_currency_code;
    if (!b || !base || activeCode.value === base) return baseAmount;
    const factor = b.display_rates?.[activeCode.value];
    return factor ? baseAmount * factor : baseAmount;
  }

  return { code, activeCode, options, symbol, amount, setCode };
}
