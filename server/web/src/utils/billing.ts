// 计费字段的选项与口径（对齐参考面板）：
//   价格 price：0 = 不显示、-1 = 免费、>0 = 实际金额
//   货币 currency：前 9 个沿用历史符号（老节点编辑时能正确回显）；
//     其余因符号有歧义（$ / ¥ 被多国共用）改用 ISO 码，服务端 normalizeCurrency 会归一化。
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
  { symbol: 'JPY', key: 'jpy' },
  { symbol: 'HKD', key: 'hkd' },
  { symbol: 'TWD', key: 'twd' },
  { symbol: 'AUD', key: 'aud' },
  { symbol: 'CAD', key: 'cad' },
  { symbol: 'SGD', key: 'sgd' },
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

// 资产汇率的币种白名单：与 server/src/billing.js 的 CURRENCY_META 保持一致。
// ISO 码是存储/汇率主键，符号只用于展示（$ 与 ¥ 在多国共用，故用带前缀的符号区分）。
export const CURRENCY_OPTIONS = ([
  ['CNY', '¥', '人民币'], ['USD', '$', '美元'], ['EUR', '€', '欧元'], ['GBP', '£', '英镑'],
  ['JPY', 'JP¥', '日元'], ['HKD', 'HK$', '港币'], ['KRW', '₩', '韩元'], ['RUB', '₽', '卢布'],
  ['THB', '฿', '泰铢'], ['VND', '₫', '越南盾'], ['INR', '₹', '卢比'], ['AUD', 'A$', '澳元'],
  ['CAD', 'C$', '加元'], ['SGD', 'S$', '新加坡元'], ['TWD', 'NT$', '新台币'], ['CHF', '₣', '法郎'],
  ['TRY', '₺', '里拉'], ['UAH', '₴', '格里夫纳'], ['BRL', 'R$', '雷亚尔'], ['MXN', 'Mex$', '墨西哥比索'],
] as const).map(([code, symbol, name]) => ({ code, symbol, name }));
