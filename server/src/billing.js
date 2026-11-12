// 计费折算（复刻 Komari 的「剩余价值」逻辑）
//
// Komari 的资产统计/交易模态框口径：
//   剩余价值 = 价格 × 剩余天数 ÷ 计费周期天数（按 UTC 整日差计算，避免时区导致 ±1 天）
//   总价值   = 各节点价格之和；月均支出 = 价格 ÷ 周期天数 × 30
// 特殊情形（Komari 同样不参与折算，界面上标为「免费 / 长期」）：
//   price = 0   → 不显示（未填写价格）
//   price = -1  → 免费，剩余价值记 0
//   expire 为空 → 长期，无到期日无法折算，剩余价值记空
//   billing_cycle ≤ 0 → 一次性 / 白嫖，没有可折算的周期，剩余价值按原价计
//   已过期     → 剩余价值 0
// 剩余天数超过一个周期时按「一期价格」封顶，避免预付多期时算出超过实付的金额。
const DAY_MS = 86400000;

/** UTC 当日 00:00 的时间戳（只按日期比较，不掺本地时区） */
function utcDayStart(input) {
  const d = input instanceof Date ? input : new Date(input);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * 计算单个节点的计费折算值。
 * @param {object} agent agents 表行（price / billing_cycle / currency / expire_at）
 * @param {number} [now] 当前时间戳（便于测试）
 * @returns {{billing_status: string, remaining_days: number|null, remaining_value: number|null, monthly_cost: number|null}}
 */
function computeBilling(agent, now = Date.now()) {
  const out = {
    billing_status: 'unset',   // unset | free | long_term | one_off | expired | active | invalid
    remaining_days: null,
    remaining_value: null,
    monthly_cost: null,
  };
  if (!agent) return out;

  const price = Number(agent.price);
  if (!Number.isFinite(price) || price === 0) return out;          // 0 = 不显示
  if (price < 0) { out.billing_status = 'free'; out.remaining_value = 0; return out; }

  const cycle = Number(agent.billing_cycle);
  const cycleDays = Number.isFinite(cycle) && cycle > 0 ? cycle : null;
  if (cycleDays) out.monthly_cost = round2((price / cycleDays) * 30);

  const raw = String(agent.expire_at || '').trim();
  if (!raw) {
    // 长期：没有到期日，剩余价值无从折算（Komari 显示为「长期」）
    out.billing_status = 'long_term';
    if (!cycleDays) { out.billing_status = 'one_off'; }
    return out;
  }
  const exp = Date.parse(`${raw.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(exp)) { out.billing_status = 'invalid'; return out; }

  const days = Math.round((exp - utcDayStart(now)) / DAY_MS);
  out.remaining_days = days;
  if (days <= 0) {
    out.billing_status = 'expired';
    out.remaining_value = 0;
    return out;
  }
  out.billing_status = 'active';
  if (cycleDays) {
    out.remaining_value = round2((price * Math.min(days, cycleDays)) / cycleDays);
  } else {
    // 一次性（billing_cycle = -1 / 0）：无周期可折算，按原价计入
    out.billing_status = 'one_off';
    out.remaining_value = round2(price);
  }
  return out;
}

/**
 * 汇总多个节点（资产统计）。
 * @returns {{count:number, total_value:number, remaining_value:number, monthly_cost:number, currency:string}}
 */
function summarizeBilling(agents, now = Date.now()) {
  const list = Array.isArray(agents) ? agents : [];
  let totalValue = 0;
  let remaining = 0;
  let monthly = 0;
  let currency = '¥';
  for (const a of list) {
    const b = computeBilling(a, now);
    const price = Number(a.price);
    if (Number.isFinite(price) && price > 0) {
      totalValue += price;
      monthly += b.monthly_cost || 0;
      currency = a.currency || currency;
    }
    if (b.remaining_value) remaining += b.remaining_value;
  }
  return {
    count: list.length,
    total_value: round2(totalValue),
    remaining_value: round2(remaining),
    monthly_cost: round2(monthly),
    currency,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 币种元数据：ISO 码是**存储与汇率的主键**，符号只用于展示。
// 同一符号可能对应多个币种（$ = USD/CAD/AUD…，¥ = CNY/JPY），所以符号→ISO 只收
// diting 既有九种符号里无歧义的那几个；要表达日元请显式写 JPY。
const CURRENCY_META = {
  CNY: { symbol: '¥', name: '人民币' },
  USD: { symbol: '$', name: '美元' },
  EUR: { symbol: '€', name: '欧元' },
  GBP: { symbol: '£', name: '英镑' },
  JPY: { symbol: 'JP¥', name: '日元' },
  HKD: { symbol: 'HK$', name: '港币' },
  KRW: { symbol: '₩', name: '韩元' },
  RUB: { symbol: '₽', name: '卢布' },
  THB: { symbol: '฿', name: '泰铢' },
  VND: { symbol: '₫', name: '越南盾' },
  INR: { symbol: '₹', name: '卢比' },
  AUD: { symbol: 'A$', name: '澳元' },
  CAD: { symbol: 'C$', name: '加元' },
  SGD: { symbol: 'S$', name: '新加坡元' },
  TWD: { symbol: 'NT$', name: '新台币' },
  CHF: { symbol: '₣', name: '法郎' },
  TRY: { symbol: '₺', name: '里拉' },
  UAH: { symbol: '₴', name: '格里夫纳' },
  BRL: { symbol: 'R$', name: '雷亚尔' },
  MXN: { symbol: 'Mex$', name: '墨西哥比索' },
};
const CURRENCIES = Object.keys(CURRENCY_META);   // ISO 列表 = 合法主键集合
// 存量数据存的是符号（兼容层也仍按符号对外）。用元数据反向生成「符号→ISO」，
// 只收唯一符号；'￥'(全角) 单独补一条。歧义符号请显式写 ISO（例如 JPY 不要只写 ¥）。
const LEGACY_SYMBOLS = (() => {
  const map = { '￥': 'CNY' };
  for (const [code, meta] of Object.entries(CURRENCY_META)) {
    if (!(meta.symbol in map)) map[meta.symbol] = code;
  }
  return map;
})();

/** 归一化到 ISO 码；无法识别返回 null（不猜，避免把 JPY 错标成 CNY）。 */
function normalizeCurrency(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return 'CNY';
  const up = raw.toUpperCase().replace(/\s+/g, '');
  if (CURRENCY_META[up]) return up;
  return LEGACY_SYMBOLS[raw] || LEGACY_SYMBOLS[up] || null;
}

/** ISO 码 → 展示符号；未知码原样返回，避免出现空符号。 */
function currencySymbol(code) {
  const meta = CURRENCY_META[String(code || '').toUpperCase()];
  return (meta && meta.symbol) || String(code || '');
}

/**
 * 按币种分桶汇总（绝不跨币种相加）。
 * @returns {{count:number, by_currency: Record<string,{total_value:number,remaining_value:number,monthly_cost:number}>}}
 */
function summarizeByCurrency(agents, now = Date.now()) {
  const list = Array.isArray(agents) ? agents : [];
  const by = {};
  for (const a of list) {
    const b = computeBilling(a, now);
    // 桶键统一用 ISO：存量 '¥'/'$' 与 'CNY'/'USD' 归到同一个桶，避免同币种被拆成两行
    const cur = normalizeCurrency(a.currency) || String(a.currency || 'CNY');
    const bucket = by[cur] || (by[cur] = { total_value: 0, remaining_value: 0, monthly_cost: 0 });
    const price = Number(a.price);
    if (Number.isFinite(price) && price > 0) {
      bucket.total_value += price;
      bucket.monthly_cost += b.monthly_cost || 0;
    }
    if (b.remaining_value) bucket.remaining_value += b.remaining_value;
  }
  for (const k of Object.keys(by)) {
    const x = by[k];
    x.total_value = round2(x.total_value);
    x.remaining_value = round2(x.remaining_value);
    x.monthly_cost = round2(x.monthly_cost);
  }
  return { count: list.length, by_currency: by };
}

/**
 * 折算到标准货币。rates[c] = 1 单位 c 折合多少标准货币；c === base 时恒为 1。
 * 缺汇率（或汇率非正/非法）的币种**不计入总额**，只列进 missing —— 绝不隐式按 1:1
 * 计入，否则会出现「$100 与 ¥100 相加」这类错账。
 */
function convertSummary(summary, cfg = {}) {
  const base = normalizeCurrency(cfg && cfg.base_currency) || 'CNY';
  // source=api 时以自动汇率为准，缺的币种回退到手工值（仍缺则进 missing）。
  // 兼容旧符号键（历史设置里存的是 '¥'/'$'），读时统一转 ISO。
  const manualRates = (cfg && cfg.rates) || {};
  const apiRates = (cfg && cfg.source === 'api' && cfg.api && cfg.api.rates) || {};
  const rawRates = { ...manualRates, ...apiRates };
  const rates = {};
  for (const [k, v] of Object.entries(rawRates)) {
    const code = normalizeCurrency(k);
    if (code) rates[code] = v;
  }
  const src = (summary && summary.by_currency) || {};
  const out = {};
  const missing = [];
  let total = 0, remaining = 0, monthly = 0;
  for (const key of Object.keys(src)) {
    const v = src[key];
    const code = normalizeCurrency(key) || key;
    let rate = null;
    if (code === base) rate = 1;
    else {
      const r = Number(rates[code]);
      if (Number.isFinite(r) && r > 0) rate = r;
    }
    if (rate === null) {
      missing.push(code);
      out[code] = { code, symbol: currencySymbol(code), rate: null, original: v, converted: null };
      continue;
    }
    const converted = {
      total_value: round2(v.total_value * rate),
      remaining_value: round2(v.remaining_value * rate),
      monthly_cost: round2(v.monthly_cost * rate),
    };
    out[code] = { code, symbol: currencySymbol(code), rate, original: v, converted };
    total += converted.total_value;
    remaining += converted.remaining_value;
    monthly += converted.monthly_cost;
  }
  // 访客侧展示换算表：1 标准币 = N 目标币。只给能算出来的币种（有汇率或就是标准币），
  // 不含汇率来源/更新时间等配置信息，公开接口下发也不会泄露后台设置。
  const displayRates = {};
  for (const [code, bucket] of Object.entries(out)) {
    if (!bucket.rate) continue;
    displayRates[code] = Math.round((1 / bucket.rate) * 1e6) / 1e6;
  }
  return {
    // base_currency 保留为「符号」以满足既有前端；code/symbol 供新前端精确展示
    base_currency: currencySymbol(base),
    base_currency_code: base,
    base_symbol: currencySymbol(base),
    fx_updated_at: Number(cfg && cfg.updated_at) || 0,
    fx_source: cfg && cfg.source === 'api' ? 'api' : 'manual',
    fx_provider: (cfg && cfg.source === 'api' && cfg.api && cfg.api.provider) || '',
    fx_api_updated_at: (cfg && cfg.source === 'api' && cfg.api && Number(cfg.api.updated_at)) || 0,
    total_value: round2(total),
    remaining_value: round2(remaining),
    monthly_cost: round2(monthly),
    by_currency: out,
    missing,
    display_rates: displayRates,
  };
}

module.exports = {
  computeBilling, summarizeBilling, summarizeByCurrency, convertSummary, utcDayStart,
  CURRENCIES, CURRENCY_META, normalizeCurrency, currencySymbol,
};
