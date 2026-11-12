// 汇率自动刷新（可选，默认关闭 = 只用手工汇率）。
//
// 纪律：
//   - 只用**硬编码**的公开汇率源做兜底，绝不接受用户可配 URL（避免 SSRF）；
//   - 只走 https、8s 超时、响应体上限 64 KiB、3xx 一律视为失败；
//   - 拉取失败不抛给请求路径：保留上一次成功快照，只把状态写进 ui_settings.billing.api；
//   - 24h 内不重复请求（`FX_TTL_MS`），失败后 5 分钟内也不再重试（`FX_RETRY_MS`）。
const https = require('https');
const { URL } = require('url');
const db = require('./db');
const { CURRENCIES, normalizeCurrency } = require('./billing');

const TIMEOUT_MS = 8000;
const MAX_BYTES = 64 * 1024;
const FX_TTL_MS = 24 * 3600 * 1000;
const FX_RETRY_MS = 5 * 60 * 1000;

// 汇率源白名单：URL 由基准币拼接，域名固定
const PROVIDERS = [
  { key: 'frankfurter', host: 'api.frankfurter.dev', url: (base, quotes) => `https://api.frankfurter.dev/v2/rates?base=${base}&quotes=${quotes}` },
  { key: 'er-api', host: 'open.er-api.com', url: (base) => `https://open.er-api.com/v6/latest/${base}` },
];

function requestJson(url, expectHost) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad_url')); }
    if (u.protocol !== 'https:' || u.hostname !== expectHost) return reject(new Error('bad_url'));
    const req = https.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': 'diting-fx/1' } }, (res) => {
      if (res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`http_${res.statusCode}`));
      }
      let size = 0;
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > MAX_BYTES) {
          req.destroy();
          reject(new Error('too_large'));
          return;
        }
        buf += chunk;
      });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('bad_json')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// 把任意汇率源响应转成 { USD: 0.14, ... }（键统一 ISO）
function pickRates(json) {
  const src = json && json.rates;
  if (!src || typeof src !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const code = normalizeCurrency(k);
    const n = Number(v);
    if (code && CURRENCIES.includes(code) && Number.isFinite(n) && n > 0) out[code] = n;
  }
  return Object.keys(out).length ? out : null;
}

function fetchLive(base) {
  const quotes = CURRENCIES.filter((c) => c !== base).join(',');
  let lastErr = new Error('failed');
  return (async () => {
    for (const p of PROVIDERS) {
      try {
        const rates = pickRates(await requestJson(p.url(base, quotes), p.host));
        if (rates) return { rates, provider: p.key };
        lastErr = new Error('no_rates');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  })();
}

function writeApi(api) {
  // 重新读一次再写：避免覆盖并发保存的设置（billing 是嵌套对象）
  const ui = db.getUiSettings();
  ui.billing = Object.assign({}, ui.billing, { api });
  db.setUiSettings(ui);
}

let inflight = null;

/**
 * 按需刷新汇率快照。
 * @param {{force?: boolean}} opts force = 忽略 24h 有效期（设置页「立即刷新」用）
 * @returns {Promise<object>} ui_settings.billing.api
 */
async function refresh(opts = {}) {
  const ui = db.getUiSettings();
  const billing = ui.billing || {};
  const base = normalizeCurrency(billing.base_currency) || 'CNY';
  const api = billing.api || {};

  // 未启用 API 模式时什么都不做（默认路径：零外呼）
  if (billing.source !== 'api') return api;
  const now = Date.now();
  if (!opts.force) {
    if (api.updated_at && now - api.updated_at < FX_TTL_MS) return api;
    // 失败后退避，避免每次定时器都打第三方
    if (api.status === 'failed' && api.last_try_at && now - api.last_try_at < FX_RETRY_MS) return api;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { rates, provider } = await fetchLive(base);
      const next = { provider, base, rates, updated_at: Date.now(), last_try_at: Date.now(), status: 'ok', error: '' };
      writeApi(next);
      return next;
    } catch (e) {
      const next = {
        ...api,
        base,
        status: 'failed',
        error: String((e && e.message) || e).slice(0, 120),
        last_try_at: Date.now(),
      };
      writeApi(next);
      return next;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

module.exports = { refresh, PROVIDERS, FX_TTL_MS };
