// 计费字段的选项与口径（对齐 Komari）：
//   价格 price：0 = 不显示、-1 = 免费、>0 = 实际金额
//   货币 currency：9 种符号
//   计费周期 billing_cycle：-1 = 一次性（不续期）、0 = 白嫖/免费、>0 = 天数
export const CURRENCIES = [
  { symbol: '¥', key: 'cny' },
  { symbol: '$', key: 'usd' },
  { symbol: '€', key: 'eur' },
  { symbol: '£', key: 'gbp' },
  { symbol: '₽', key: 'rub' },
  { symbol: '₣', key: 'chf' },
  { symbol: '₹', key: 'inr' },
  { symbol: '₫', key: 'vnd' },
  { symbol: '฿', key: 'thb' },
] as const;

export const BILLING_CYCLES = [
  { value: -1, key: 'once' },
  { value: 0, key: 'free' },
  { value: 30, key: 'monthly' },
  { value: 60, key: 'biMonthly' },
  { value: 90, key: 'quarterly' },
  { value: 180, key: 'halfYear' },
  { value: 365, key: 'yearly' },
  { value: 730, key: 'twoYear' },
  { value: 1095, key: 'threeYear' },
] as const;

/** 默认货币符号（与 db 默认值一致） */
export const DEFAULT_CURRENCY = '¥';
/** 默认计费周期（天） */
export const DEFAULT_CYCLE = 30;
