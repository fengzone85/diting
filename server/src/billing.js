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

module.exports = { computeBilling, summarizeBilling, utcDayStart };
