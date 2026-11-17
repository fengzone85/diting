(() => {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const round = (value, digits = 2) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const median = (values) => {
    if (!values.length) return 0;
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  };
  const money = (value) =>
    "¥" + Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money0 = (value) => "¥" + Math.round(value).toLocaleString("zh-CN");
  const salesText = (value) => (value >= 10000 ? `${(value / 10000).toFixed(1)}万+` : `${value}+`);
  const shortTitle = (title, length = 16) => (title.length > length ? title.slice(0, length) + "…" : title);
  const escapeHTML = (value) =>
    String(value).replace(/[&<>"']/g, (char) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  const timeLabel = () => new Date().toTimeString().slice(0, 8);

  const PALETTE = ["#dd4326", "#0e6f66", "#a56810", "#5b54c9"];
  const state = {
    keyword: "无线蓝牙耳机",
    result: null,
    sortKey: "price",
    sortDir: "asc",
    platform: "全部",
    tab: "raw",
    source: "browser",
    pythonAvailable: false,
    running: false,
  };

  function hashString(text) {
    let hash = 2166136261 >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    let value = seed >>> 0;
    return function random() {
      value = (value + 0x6d2b79f5) | 0;
      let t = Math.imul(value ^ (value >>> 15), 1 | value);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function trendLabels(days = 30) {
    const labels = [];
    const now = new Date();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
      labels.push(`${date.getMonth() + 1}/${date.getDate()}`);
    }
    return labels;
  }

  function formatSalesText(value) {
    return value >= 10000 ? `${(value / 10000).toFixed(1)}万+` : `${value}+`;
  }

  /* ------------------------------------------------------------------ */
  /* demo adapter (mirrors pricehunter/adapters/demo.py)                 */
  /* ------------------------------------------------------------------ */

  const BRANDS = ["声澜", "墨羽", "云听", "星野", "极昼", "拾光", "青柚", "白鹭", "南风"];
  const SUFFIXES = [
    "Pro 版",
    "青春版",
    "标准版",
    "降噪款",
    "旗舰款",
    "轻享版",
    "双机装",
    "礼盒装",
    "升级款",
    "经典款",
  ];
  const PLATFORMS = [
    { key: "jd", name: "京东", shop: "京东自营旗舰店", factor: 1.0 },
    { key: "tmall", name: "天猫", shop: "官方旗舰店", factor: 1.05 },
    { key: "pdd", name: "拼多多", shop: "百亿补贴", factor: 0.93 },
  ];
  const MULTIPLIERS = [0.76, 0.83, 0.91, 1.0, 1.09, 1.21, 1.36, 1.52];
  const CATEGORY_BASE = [
    [/耳机|蓝牙|音箱|耳麦/, 219],
    [/手机|iphone|华为|小米|荣耀/, 3999],
    [/键盘|鼠标|显示器|路由|硬盘/, 329],
    [/扫地|机器人|吸尘|净化器/, 1599],
    [/咖啡|茶叶|豆/, 99],
    [/面霜|精华|护肤|口红|面膜/, 239],
    [/洗衣|纸巾|日用|清洁/, 59],
    [/零食|坚果|牛奶/, 69],
  ];

  function detectBasePrice(keyword) {
    const lowered = keyword.toLowerCase();
    for (const [pattern, price] of CATEGORY_BASE) {
      if (pattern.test(lowered)) return price;
    }
    return 219;
  }

  function makeHistory(seed, finalPrice, days = 30) {
    const random = mulberry32(hashString(seed));
    const phase = random() * Math.PI * 2;
    const amplitude = 0.025 + random() * 0.06;
    let value = finalPrice * (1.02 + random() * 0.08);
    const series = [];
    for (let day = 0; day < days - 1; day += 1) {
      const progress = day / (days - 1);
      const target =
        finalPrice * (1 + amplitude * Math.sin(progress * Math.PI * 2 * 1.15 + phase) + 0.035 * (1 - progress));
      value += (target - value) * 0.42 + value * (random() - 0.5) * 0.018;
      value = Math.max(value, finalPrice * 0.72);
      series.push(round(value, 2));
    }
    series.push(round(finalPrice, 2));
    return series;
  }

  function generateDemo(keyword, limit = 28) {
    const random = mulberry32(hashString(keyword));
    const base = detectBasePrice(keyword) * (0.9 + random() * 0.2);
    const modelCount = Math.max(4, Math.ceil(limit / 1.35));
    const models = [];
    for (let index = 0; index < modelCount; index += 1) {
      models.push({
        title: `${BRANDS[index % BRANDS.length]} ${keyword} ${
          SUFFIXES[Math.floor(index / BRANDS.length) % SUFFIXES.length]
        }`,
        brand: BRANDS[index % BRANDS.length],
        base: base * MULTIPLIERS[index % MULTIPLIERS.length] * (0.97 + random() * 0.06),
      });
    }

    const items = [];
    let cursor = 0;
    while (items.length < limit) {
      const model = models[cursor % modelCount];
      const occurrence = Math.floor(cursor / modelCount);
      const platform = PLATFORMS[(cursor + occurrence) % PLATFORMS.length];
      const price = Math.max(9.9, round(model.base * platform.factor * (0.97 + random() * 0.06), 2));
      const originalPrice = round(price * (1.08 + random() * 0.3), 2);
      const sales = Math.round(10 ** (2 + random() * 2.6));
      const ratingRange =
        platform.key === "jd" ? [4.7, 4.95] : platform.key === "tmall" ? [4.55, 4.9] : [4.35, 4.8];
      const rating = round(ratingRange[0] + random() * (ratingRange[1] - ratingRange[0]), 1);

      items.push({
        source: platform.name,
        source_key: platform.key,
        title: model.title,
        price,
        original_price: originalPrice,
        sales: formatSalesText(sales),
        rating,
        shop: `${model.brand}${platform.shop}`,
        url: `https://item.example.com/${platform.key}/${10000000 + items.length * 137}`,
        history: makeHistory(`${model.title}|${platform.key}`, price),
      });
      cursor += 1;
    }
    return items;
  }

  /* ------------------------------------------------------------------ */
  /* normalization + pipeline (mirrors pricehunter/pipeline.py)          */
  /* ------------------------------------------------------------------ */

  const PROMO_TOKENS = [
    "官方旗舰店",
    "京东自营",
    "百亿补贴",
    "官方",
    "旗舰店",
    "正品",
    "包邮",
    "限时",
    "秒杀",
    "新品",
    "热卖",
  ];

  function parsePrice(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? round(value, 2) : null;
    const text = String(value).replace(/[¥￥,元\s]/g, "");
    const match = text.match(/\d+(?:\.\d+)?/);
    if (!match) return null;
    let price = parseFloat(match[0]);
    if (/万/.test(text)) price *= 10000;
    return price > 0 && Number.isFinite(price) ? round(price, 2) : null;
  }

  function parseSales(value) {
    if (value === null || value === undefined || value === "") return 0;
    if (typeof value === "number") return Math.max(0, Math.round(value));
    const text = String(value).replace(/,/g, "").replace(/[¥￥]/g, "").trim().toLowerCase();
    const match = text.match(/(\d+(?:\.\d+)?)\s*(万|w|千|k)?/);
    if (!match) return 0;
    const number = parseFloat(match[1]);
    const unit = match[2];
    const multiplier = unit === "万" || unit === "w" ? 10000 : unit === "千" || unit === "k" ? 1000 : 1;
    return Math.max(0, Math.round(number * multiplier));
  }

  function parseRating(value) {
    if (value === null || value === undefined || value === "") return 0;
    let rating = parseFloat(String(value).replace(/[分\s]/g, ""));
    if (!Number.isFinite(rating) || rating <= 0) return 0;
    if (rating > 5) rating = rating <= 100 ? rating / 20 : 5;
    return round(Math.min(rating, 5), 2);
  }

  function cleanTitle(value) {
    let text = String(value || "").normalize("NFKC");
    text = text.replace(/[【\[（(]\s*(?:官方|正品|包邮|秒杀|限时|新品|热卖)\s*[】\]）)]/g, "");
    return text.replace(/\s+/g, " ").trim();
  }

  function canonicalKey(title) {
    let text = String(title).normalize("NFKC").toLowerCase();
    for (const token of PROMO_TOKENS) text = text.split(token).join("");
    return text.replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
  }

  function quantile(values, q) {
    if (!values.length) return 0;
    const ordered = [...values].sort((a, b) => a - b);
    if (ordered.length === 1) return ordered[0];
    const position = (ordered.length - 1) * q;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    if (low === high) return ordered[low];
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low);
  }

  function niceStep(raw) {
    if (raw <= 0) return 1;
    const exponent = Math.floor(Math.log10(raw));
    const base = raw / 10 ** exponent;
    for (const candidate of [1, 2, 2.5, 5, 10]) {
      if (base <= candidate) return candidate * 10 ** exponent;
    }
    return 10 ** (exponent + 1);
  }

  function buildBands(prices) {
    if (!prices.length) return [];
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    if (Math.abs(high - low) < 1e-9) {
      return [{ label: `¥${Math.round(low)}`, from: low, to: high, count: prices.length }];
    }
    const step = niceStep((high - low) / 5);
    const start = Math.floor(low / step) * step;
    const edges = [start];
    while (edges[edges.length - 1] < high) {
      edges.push(round(edges[edges.length - 1] + step, 6));
    }
    const bands = [];
    for (let index = 0; index < edges.length - 1; index += 1) {
      const lower = edges[index];
      const upper = edges[index + 1];
      const isLast = index === edges.length - 2;
      const count = prices.filter((price) =>
        isLast ? price >= lower && price <= upper + 1e-9 : price >= lower && price < upper
      ).length;
      bands.push({
        label: `¥${Math.round(lower)}–${Math.round(upper)}`,
        from: round(lower, 2),
        to: round(upper, 2),
        count,
      });
    }
    return bands;
  }

  function normalizeValue(value, low, high) {
    if (high <= low) return 0.5;
    return clamp((value - low) / (high - low), 0, 1);
  }

  function valueLabel(score) {
    if (score >= 78) return ["性价比首选", "high"];
    if (score >= 65) return ["值得入手", "good"];
    if (score >= 52) return ["中规中矩", "mid"];
    return ["谨慎比价", "low"];
  }

  function buildReasons(item, medianPrice) {
    const reasons = [];
    if (medianPrice > 0) {
      const diff = ((item.price - medianPrice) / medianPrice) * 100;
      if (diff <= -10) reasons.push(`低于同组中位价 ${Math.abs(diff).toFixed(0)}%`);
      else if (diff <= 5) reasons.push("价格处于同组中位");
    }
    if (item.is_low30d) reasons.push("处于近 30 天价格低位");
    if (item.sales >= 10000) reasons.push(`销量 ${(item.sales / 10000).toFixed(1)} 万+`);
    else if (item.sales >= 3000) reasons.push(`销量 ${item.sales}+`);
    if (item.rating >= 4.7) reasons.push(`店铺评分 ${item.rating.toFixed(1)}`);
    if (item.original_price && item.original_price > item.price * 1.08) {
      const saved = ((item.original_price - item.price) / item.original_price) * 100;
      reasons.push(`较划线价省 ${saved.toFixed(0)}%`);
    }
    if (item.offers && item.offers.length > 1) reasons.push(`${item.offers.length} 个平台可购`);
    return reasons.slice(0, 3);
  }

  function toRawSample(item) {
    return {
      source: item.source,
      title: item.title,
      price: item.price,
      original_price: item.original_price,
      sales: item.sales,
      rating: item.rating,
      shop: item.shop,
      url: item.url,
      price_history_days: Array.isArray(item.history) ? item.history.length : 0,
    };
  }

  function analyze(rawItems, keyword, engine = "browser") {
    const started = performance.now();
    let markAt = started;
    const steps = [];
    const mark = (key, label, count, detail, fixedMs) => {
      const now = performance.now();
      steps.push({
        key,
        label,
        count,
        detail,
        ms: fixedMs !== undefined ? fixedMs : Math.max(1, Math.round(now - markAt)),
      });
      markAt = now;
    };

    mark("collect", "采集", rawItems.length, `Adapter 返回 ${rawItems.length} 条原始记录`);

    const cleaned = [];
    for (const item of rawItems) {
      const title = cleanTitle(item.title);
      const price = parsePrice(item.price);
      if (!title || price === null) continue;
      let originalPrice = parsePrice(item.original_price);
      if (originalPrice !== null && originalPrice <= price * 1.02) originalPrice = null;
      cleaned.push({
        title,
        price,
        original_price: originalPrice,
        sales: parseSales(item.sales),
        rating: parseRating(item.rating),
        shop: String(item.shop || "未知店铺").trim(),
        source: String(item.source || "模拟数据").trim(),
        source_key: String(item.source_key || item.source || "demo").trim(),
        url: String(item.url || ""),
        history: Array.isArray(item.history)
          ? item.history.map(Number).filter((value) => Number.isFinite(value) && value > 0)
          : [],
      });
    }
    const invalid = rawItems.length - cleaned.length;

    let kept = cleaned;
    let outliers = 0;
    if (cleaned.length >= 5) {
      const prices = cleaned.map((item) => item.price);
      const q1 = quantile(prices, 0.25);
      const q3 = quantile(prices, 0.75);
      const iqr = q3 - q1;
      const lower = q1 - 3 * iqr;
      const upper = q3 + 3 * iqr;
      kept = cleaned.filter((item) => item.price >= lower && item.price <= upper);
      outliers = cleaned.length - kept.length;
    }
    mark("clean", "清洗", kept.length, `剔除 ${invalid} 条无效 · ${outliers} 条异常价格`);

    const groups = new Map();
    for (const item of kept) {
      const key = canonicalKey(item.title) || item.title;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    let items = [];
    let merged = 0;
    for (const group of groups.values()) {
      group.sort((a, b) => a.price - b.price || b.rating - a.rating);
      const best = { ...group[0], tags: [], reasons: [] };
      best.offers = group.map((offer) => ({
        source: offer.source,
        source_key: offer.source_key,
        shop: offer.shop,
        price: offer.price,
        url: offer.url,
      }));
      best.sales = Math.max(...group.map((offer) => offer.sales));
      if (group.length > 1) {
        best.tags.push("多平台同款");
        merged += group.length - 1;
      }
      items.push(best);
    }
    mark("dedupe", "去重", items.length, `合并 ${merged} 条跨平台同款`);

    const priceMin = items.length ? Math.min(...items.map((item) => item.price)) : 0;
    const priceMax = items.length ? Math.max(...items.map((item) => item.price)) : 0;
    const maxLogSales = items.length ? Math.log1p(Math.max(...items.map((item) => item.sales))) || 1 : 1;
    const knownRatings = items.map((item) => item.rating).filter((rating) => rating > 0);
    const fallbackRating = knownRatings.length ? mean(knownRatings) : 4.5;

    for (const item of items) {
      const priceRatio = normalizeValue(item.price, priceMin, priceMax);
      const salesRatio = Math.log1p(item.sales) / maxLogSales;
      const ratingRatio = normalizeValue(item.rating || fallbackRating, 3.8, 5);
      item.value_score = round(100 * (0.46 * (1 - priceRatio) + 0.29 * salesRatio + 0.25 * ratingRatio), 1);
      const [label, tone] = valueLabel(item.value_score);
      item.value_label = label;
      item.value_tone = tone;

      if (item.history.length) {
        const previous = item.history.slice(0, -1);
        item.is_low30d = item.price <= Math.min(...(previous.length ? previous : item.history)) * 1.005;
        item.change_pct = round(((item.price - item.history[0]) / item.history[0]) * 100, 1);
      } else {
        item.is_low30d = false;
        item.change_pct = 0;
      }
    }
    mark("score", "评分", items.length, "价格 46% · 销量 29% · 评分 25%");

    items.sort((a, b) => a.price - b.price || b.value_score - a.value_score);
    const lowest = items.length ? items[0].price : 0;
    items.forEach((item, index) => {
      item.rank = index + 1;
      item.id = `p${String(index + 1).padStart(3, "0")}`;
      item.tags = item.tags.filter((tag) => tag !== "全场最低");
      if (items.length && item.price <= lowest + 1e-9) item.tags.unshift("全场最低");
      if (item.is_low30d && !item.tags.includes("近30天低价")) item.tags.push("近30天低价");
      item.tags = item.tags.slice(0, 3);
    });
    mark("sort", "排序", items.length, "价格从低到高");

    const prices = items.map((item) => item.price);
    const medianPrice = prices.length ? round(median(prices), 2) : 0;
    for (const item of items) item.reasons = buildReasons(item, medianPrice);

    const recommendations = [...items]
      .sort((a, b) => b.value_score - a.value_score || a.price - b.price)
      .slice(0, 3)
      .map((item) => ({ ...item, reasons: item.reasons.length ? item.reasons : ["综合性价比指数进入前三"] }));

    const platformCounts = new Map();
    for (const item of items) platformCounts.set(item.source, (platformCounts.get(item.source) || 0) + 1);
    const platforms = Array.from(platformCounts.entries()).map(([name, count]) => ({ name, count }));

    const stats = {
      raw_count: rawItems.length,
      cleaned_count: cleaned.length,
      valid_count: kept.length,
      final_count: items.length,
      invalid_count: invalid,
      outlier_count: outliers,
      merged_count: merged,
      removed_count: rawItems.length - kept.length,
      min_price: prices.length ? round(Math.min(...prices), 2) : 0,
      max_price: prices.length ? round(Math.max(...prices), 2) : 0,
      median_price: medianPrice,
      avg_price: prices.length ? round(mean(prices), 2) : 0,
      saving: prices.length ? round(Math.max(...prices) - Math.min(...prices), 2) : 0,
      saving_pct:
        prices.length && Math.min(...prices) > 0
          ? round(((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100, 1)
          : 0,
      low30d_count: items.filter((item) => item.is_low30d).length,
      best_value_id: recommendations.length ? recommendations[0].id : null,
      platforms,
    };

    return {
      meta: {
        keyword,
        source: "demo",
        engine,
        collected_at: new Date().toISOString(),
        disclaimer: "演示数据由内置模拟适配器确定性生成，不代表真实商品、价格或库存。",
      },
      steps,
      stats,
      bands: buildBands(prices),
      items,
      recommendations,
      raw_sample: rawItems.slice(0, 3).map(toRawSample),
    };
  }

  /* ------------------------------------------------------------------ */
  /* logging                                                             */
  /* ------------------------------------------------------------------ */

  function clearLog() {
    $("#logBody").innerHTML = "";
  }

  function addLog(message, type = "") {
    const body = $("#logBody");
    const line = document.createElement("div");
    line.className = "log-line";
    line.innerHTML = `<span class="log-time">${timeLabel()}</span><span class="log-msg ${type}">${escapeHTML(
      message
    )}</span>`;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
  }

  async function animateLogs(result) {
    for (const step of result.steps) {
      addLog(`✓ ${step.label}  ${step.detail}  ${step.ms}ms`, "ok");
      await wait(105);
    }
    addLog(`→ 输出 ${result.stats.final_count} 条对比结果 · ${result.recommendations.length} 款性价比推荐`, "info");
  }

  function setRunning(running) {
    const button = $("#runBtn");
    const badge = $("#runBadge");
    button.disabled = running;
    $("#runBtnText").textContent = running ? "采集中…" : "开始采集";
    badge.textContent = running ? "RUNNING" : "DONE";
    badge.className = `run-badge${running ? " running" : ""}`;
  }

  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => element.classList.remove("show"), 2800);
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */

  function renderKPIs(result) {
    const stats = result.stats;
    const lowest = result.items[0];
    const best = [...result.items].sort((a, b) => b.value_score - a.value_score)[0];
    const cards = [
      {
        label: "采集 → 去重",
        value: `${stats.raw_count}<small>→</small>${stats.final_count}`,
        tone: "",
        sub: `剔除 ${stats.invalid_count + stats.outlier_count} 条无效/异常 · 合并 ${stats.merged_count} 条同款`,
      },
      {
        label: "最低到手价",
        value: money0(stats.min_price),
        tone: "accent",
        sub: lowest ? `${escapeHTML(lowest.source)} · ${escapeHTML(shortTitle(lowest.title, 18))}` : "—",
      },
      {
        label: "价格中位",
        value: money0(stats.median_price),
        tone: "",
        sub: `区间 ${money0(stats.min_price)} – ${money0(stats.max_price)}`,
      },
      {
        label: "比价空间",
        value: money0(stats.saving),
        tone: "gold",
        sub: `最高与最低相差 ${stats.saving_pct}%`,
      },
      {
        label: "最高性价比",
        value: best ? best.value_score.toFixed(1) : "—",
        tone: "teal",
        sub: best ? `${escapeHTML(shortTitle(best.title, 18))} · ${escapeHTML(best.value_label)}` : "—",
      },
    ];
    $("#kpiGrid").innerHTML = cards
      .map(
        (card, index) => `<article class="kpi" data-tone="${card.tone}" style="--d:${index * 45}ms">
        <span class="kpi-label">${card.label}</span>
        <div class="kpi-value">${card.value}</div>
        <p class="kpi-sub">${card.sub}</p>
      </article>`
      )
      .join("");
  }

  function renderStages(result) {
    $("#stageList").innerHTML = result.steps
      .map(
        (step, index) => `<li style="--d:${index * 50}ms">
        <div class="stage-top">
          <span class="stage-idx">STEP ${String(index + 1).padStart(2, "0")}</span>
          <em>${step.ms} ms</em>
        </div>
        <strong>${escapeHTML(step.label)}</strong>
        <p>${escapeHTML(step.detail)}</p>
        <b>${step.count}</b>
      </li>`
      )
      .join("");
    const total = result.steps.reduce((sum, step) => sum + step.ms, 0);
    $("#stageMeta").textContent = `${result.meta.engine === "python" ? "PYTHON" : "BROWSER"} · ${total}ms · ${result.meta.collected_at
      .replace("T", " ")
      .slice(0, 19)}`;
  }

  function renderRecommendations(result) {
    $("#recoGrid").innerHTML = result.recommendations
      .map(
        (item, index) => `<article class="reco-card" data-tone="${item.value_tone}" style="--d:${index * 60}ms">
        <span class="reco-rank">${String(index + 1).padStart(2, "0")}</span>
        <span class="reco-badge">${escapeHTML(item.value_label)} · ${item.value_score.toFixed(1)}</span>
        <h3 class="reco-title">${escapeHTML(item.title)}</h3>
        <div class="reco-price">
          <b>${money(item.price)}</b>
          ${item.original_price ? `<s>${money(item.original_price)}</s>` : ""}
        </div>
        <p class="reco-meta">${escapeHTML(item.source)} · ${escapeHTML(item.shop)} · ${item.rating.toFixed(
          1
        )} 分 · ${salesText(item.sales)}</p>
        <ul class="reco-reasons">${item.reasons.map((reason) => `<li>${escapeHTML(reason)}</li>`).join("")}</ul>
        <div class="score-row">
          <span class="score-track"><i style="width:${item.value_score}%"></i></span>
          <b>${item.value_score.toFixed(1)}</b>
          <small>/100</small>
        </div>
        <a class="reco-link" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer">查看商品 ↗</a>
      </article>`
      )
      .join("");
  }

  function sortLabel() {
    const names = { price: "价格", value_score: "性价比", sales: "销量", rating: "评分", title: "商品名", source: "平台" };
    return `${names[state.sortKey] || state.sortKey}${state.sortDir === "asc" ? "升序" : "降序"}`;
  }

  function filteredItems() {
    if (!state.result) return [];
    let items = state.result.items.filter((item) => state.platform === "全部" || item.source === state.platform);
    const direction = state.sortDir === "asc" ? 1 : -1;
    items = [...items].sort((a, b) => {
      if (state.sortKey === "title") return a.title.localeCompare(b.title, "zh-CN") * direction;
      if (state.sortKey === "source") return a.source.localeCompare(b.source, "zh-CN") * direction;
      const left = a[state.sortKey];
      const right = b[state.sortKey];
      if (left === right) return a.price - b.price;
      return (left - right) * direction;
    });
    return items;
  }

  function renderFilters(result) {
    const options = [{ name: "全部", count: result.items.length }, ...result.stats.platforms];
    $("#platformFilters").innerHTML = options
      .map(
        (option) =>
          `<button type="button" class="filter ${state.platform === option.name ? "active" : ""}" data-platform="${escapeHTML(
            option.name
          )}">${escapeHTML(option.name)} ${option.count}</button>`
      )
      .join("");
  }

  function updateSortHeaders() {
    $$(".compare-table th.sortable").forEach((header) => {
      const active = header.dataset.sort === state.sortKey;
      header.classList.toggle("sorted", active);
      const arrow = header.querySelector(".arrow");
      if (arrow) arrow.textContent = active ? (state.sortDir === "asc" ? "↑" : "↓") : "↑";
    });
  }

  function renderTable(result) {
    const items = filteredItems();
    const tagClass = (tag) => (tag === "全场最低" ? "hot" : tag === "近30天低价" ? "cool" : "neutral");

    $("#tableBody").innerHTML = items.length
      ? items
          .map((item) => {
            const tags = item.tags.length
              ? item.tags.map((tag) => `<span class="tag ${tagClass(tag)}">${escapeHTML(tag)}</span>`).join("")
              : '<span class="tag neutral">—</span>';
            const delta =
              item.change_pct && Math.abs(item.change_pct) >= 0.05
                ? `<span class="delta ${item.change_pct > 0 ? "up" : ""}">${item.change_pct > 0 ? "+" : ""}${item.change_pct.toFixed(
                    1
                  )}% / 30天</span>`
                : "";
            return `<tr>
              <td class="col-rank"><span class="rank">${String(item.rank).padStart(2, "0")}</span></td>
              <td>
                <div class="prod">
                  <strong>${escapeHTML(item.title)}</strong>
                  <small>${escapeHTML(item.shop)}${item.offers.length > 1 ? ` · ${item.offers.length} 个平台报价` : ""}</small>
                </div>
              </td>
              <td><span class="platform" data-key="${escapeHTML(item.source_key)}"><i></i>${escapeHTML(
              item.source
            )}</span></td>
              <td class="num price">
                <b>${money(item.price)}</b>${item.original_price ? `<s>${money(item.original_price)}</s>` : ""}
                ${delta}
              </td>
              <td class="num">${salesText(item.sales)}</td>
              <td class="num rating"><span class="star">★</span>${item.rating.toFixed(1)}</td>
              <td class="num">
                <div class="value" data-tone="${item.value_tone}">
                  <b>${item.value_score.toFixed(1)}</b>
                  <span class="vbar"><i style="width:${item.value_score}%"></i></span>
                </div>
              </td>
              <td><div class="tags">${tags}</div></td>
              <td class="num"><a class="url-link" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer">查看 ↗</a></td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="9" style="padding:36px;text-align:center;color:var(--faint)">没有符合筛选条件的商品</td></tr>`;

    $("#tableMeta").textContent = `共 ${items.length} 条 · ${
      state.platform === "全部" ? "全部平台" : state.platform
    } · ${sortLabel()}`;
    $("#tableFoot").innerHTML = `<span>采集 ${result.stats.raw_count} → 清洗 ${result.stats.valid_count} → 去重 ${
      result.stats.final_count
    } 条</span><span>标记说明：全场最低 / 近30天低价 / 多平台同款 · 点击表头切换排序</span>`;
    updateSortHeaders();
  }

  function renderBands(result) {
    const bands = result.bands;
    if (!bands.length) {
      $("#bandChart").innerHTML = '<p class="chart-note">暂无价格分布数据</p>';
      $("#bandFoot").innerHTML = "";
      return;
    }
    const max = Math.max(...bands.map((band) => band.count), 1);
    const medianPrice = result.stats.median_price;
    $("#bandChart").innerHTML = bands
      .map((band, index) => {
        const hot = medianPrice >= band.from && (medianPrice < band.to || index === bands.length - 1);
        return `<div class="band-row ${hot ? "hot" : ""}">
          <span class="band-label">${escapeHTML(band.label)}</span>
          <span class="band-track"><i data-width="${Math.max(5, (band.count / max) * 100)}"></i></span>
          <b>${band.count}</b>
        </div>`;
      })
      .join("");
    requestAnimationFrame(() => {
      $$("#bandChart .band-track i").forEach((bar) => {
        bar.style.width = `${bar.dataset.width}%`;
      });
    });
    $("#bandMeta").textContent = `${bands.length} 个价格带 · 中位价 ${money(result.stats.median_price)}`;
    $("#bandFoot").innerHTML = `<span>最低 <b>${money(result.stats.min_price)}</b></span><span>中位 <b>${money(
      result.stats.median_price
    )}</b></span><span>最高 <b>${money(result.stats.max_price)}</b></span>`;
  }

  function renderTrend(result) {
    const labels = trendLabels(30);
    const top = [...result.items].sort((a, b) => b.value_score - a.value_score).slice(0, 3);
    const series = top
      .filter((item) => Array.isArray(item.history) && item.history.length)
      .map((item, index) => ({
        name: item.title,
        color: PALETTE[index % PALETTE.length],
        values: item.history.slice(-30),
      }));
    const marketValues = labels.map((_, index) =>
      median(result.items.map((item) => item.history && item.history[index]).filter((value) => typeof value === "number"))
    );

    if (!series.length) {
      $("#trendChart").innerHTML = '<p class="chart-note" style="padding:40px 0">暂无历史价格数据，接入历史快照后可绘制趋势。</p>';
      $("#trendLegend").innerHTML = "";
      $("#trendMeta").textContent = "—";
      return;
    }

    const width = 780;
    const height = 312;
    const padding = { top: 20, right: 16, bottom: 38, left: 54 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const allValues = [...series.flatMap((item) => item.values), ...marketValues].filter((value) =>
      Number.isFinite(value)
    );
    const rawMin = Math.min(...allValues);
    const rawMax = Math.max(...allValues);
    const extra = (rawMax - rawMin) * 0.18 || Math.max(10, rawMax * 0.05);
    const step = niceStep((rawMax - rawMin + extra * 2) / 4 || 10);
    const axisMin = Math.max(0, Math.floor((rawMin - extra) / step) * step);
    const axisMax = Math.ceil((rawMax + extra) / step) * step;
    const xAt = (index) => padding.left + (index / Math.max(1, labels.length - 1)) * innerWidth;
    const yAt = (value) => padding.top + (1 - (value - axisMin) / (axisMax - axisMin || 1)) * innerHeight;

    let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="近 30 天价格走势">`;
    svg += `<defs><linearGradient id="marketArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8b857a" stop-opacity="0.13"></stop>
      <stop offset="100%" stop-color="#8b857a" stop-opacity="0"></stop>
    </linearGradient></defs>`;

    for (let value = axisMin; value <= axisMax + 1e-9; value += step) {
      const y = yAt(value);
      svg += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#eae4d8" stroke-width="1"></line>`;
      svg += `<text x="${padding.left - 10}" y="${y + 3.5}" text-anchor="end" font-size="9" fill="#a29c90" font-family="monospace">${Math.round(
        value
      )}</text>`;
    }
    labels.forEach((label, index) => {
      if (index % 5 === 0 || index === labels.length - 1) {
        svg += `<text x="${xAt(index)}" y="${
          height - 14
        }" text-anchor="middle" font-size="9" fill="#a29c90" font-family="monospace">${label}</text>`;
      }
    });

    if (marketValues.length) {
      const line = marketValues.map((value, index) => `${index ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`).join(" ");
      const area = `${line} L${xAt(marketValues.length - 1).toFixed(1)},${height - padding.bottom} L${xAt(0).toFixed(
        1
      )},${height - padding.bottom} Z`;
      svg += `<path d="${area}" fill="url(#marketArea)"></path>`;
      svg += `<path d="${line}" fill="none" stroke="#8b857a" stroke-width="1.5" stroke-dasharray="4 5" stroke-linecap="round"></path>`;
    }

    series.forEach((item, index) => {
      const line = item.values
        .map((value, point) => `${point ? "L" : "M"}${xAt(point).toFixed(1)},${yAt(value).toFixed(1)}`)
        .join(" ");
      svg += `<path class="trend-path" style="animation-delay:${index * 90}ms" d="${line}" fill="none" stroke="${
        item.color
      }" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" pathLength="1"></path>`;
      const lastIndex = item.values.length - 1;
      svg += `<circle cx="${xAt(lastIndex)}" cy="${yAt(item.values[lastIndex])}" r="3.4" fill="#fffdf8" stroke="${
        item.color
      }" stroke-width="2"></circle>`;
    });

    svg += `<g id="hoverGroup" opacity="0"><line id="hoverLine" y1="${padding.top}" y2="${
      height - padding.bottom
    }" stroke="#b9b1a3" stroke-width="1" stroke-dasharray="3 3"></line></g>`;
    svg += `<rect id="chartOverlay" x="${padding.left}" y="${padding.top}" width="${innerWidth}" height="${innerHeight}" fill="transparent" style="cursor:crosshair"></rect>`;
    svg += "</svg>";

    $("#trendChart").innerHTML = svg;
    $("#trendLegend").innerHTML =
      series
        .map(
          (item) =>
            `<span title="${escapeHTML(item.name)}"><i style="background:${item.color}"></i>${escapeHTML(
              shortTitle(item.name, 12)
            )}</span>`
        )
        .join("") +
      '<span><i style="background:repeating-linear-gradient(90deg,#8b857a 0 3px,transparent 3px 6px)"></i>市场中位</span>';

    const first = marketValues.find((value) => Number.isFinite(value));
    const last = [...marketValues].reverse().find((value) => Number.isFinite(value));
    const change = first ? ((last - first) / first) * 100 : 0;
    $("#trendMeta").textContent = `市场中位 ${money(last)} · 30 天 ${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;

    const svgElement = $("#trendChart svg");
    const overlay = $("#chartOverlay");
    const hoverGroup = $("#hoverGroup");
    const hoverLine = $("#hoverLine");
    const tooltip = $("#chartTip");
    if (!svgElement || !overlay) return;

    const onMove = (event) => {
      if (window.matchMedia("(max-width: 760px)").matches) return;
      const rect = svgElement.getBoundingClientRect();
      const pointerX = ((event.clientX - rect.left) / rect.width) * width;
      const index = clamp(
        Math.round(((pointerX - padding.left) / innerWidth) * (labels.length - 1)),
        0,
        labels.length - 1
      );
      const x = xAt(index);
      hoverLine.setAttribute("x1", x);
      hoverLine.setAttribute("x2", x);
      hoverGroup.setAttribute("opacity", "1");

      const rows = [
        ...series.map((item) => ({ name: item.name, color: item.color, value: item.values[index] })),
        { name: "市场中位价", color: "#8b857a", value: marketValues[index] },
      ].filter((row) => Number.isFinite(row.value));

      tooltip.innerHTML =
        `<b>${labels[index]}</b>` +
        rows
          .map(
            (row) =>
              `<div class="tip-row"><span class="tip-name"><em style="background:${row.color}"></em>${escapeHTML(
                shortTitle(row.name, 13)
              )}</span><span>${money(row.value)}</span></div>`
          )
          .join("");
      tooltip.style.left = `${clamp((x / width) * 100, 15, 85)}%`;
      tooltip.style.top = "6px";
      tooltip.hidden = false;
    };

    overlay.addEventListener("mousemove", onMove);
    overlay.addEventListener("mouseleave", () => {
      hoverGroup.setAttribute("opacity", "0");
      tooltip.hidden = true;
    });
  }

  function highlightJSON(text) {
    const token =
      /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g;
    let output = "";
    let lastIndex = 0;
    let match;
    while ((match = token.exec(text)) !== null) {
      output += escapeHTML(text.slice(lastIndex, match.index));
      let className = "j-num";
      if (match[0].startsWith('"')) className = /:\s*$/.test(match[0]) ? "j-key" : "j-str";
      else if (/^(true|false|null)$/.test(match[0])) className = "j-bool";
      output += `<span class="${className}">${escapeHTML(match[0])}</span>`;
      lastIndex = match.index + match[0].length;
    }
    output += escapeHTML(text.slice(lastIndex));
    return output;
  }

  function renderData(result) {
    let data;
    let title;
    let hint;
    if (state.tab === "raw") {
      data = result.raw_sample;
      title = "raw_items.json";
      hint = "取自本次采集的前 3 条";
    } else if (state.tab === "clean") {
      data = result.items.slice(0, 3).map((item) => ({
        rank: item.rank,
        title: item.title,
        price: item.price,
        original_price: item.original_price,
        sales: item.sales,
        rating: item.rating,
        shop: item.shop,
        source: item.source,
        value_score: item.value_score,
        value_label: item.value_label,
        tags: item.tags,
        is_low30d: item.is_low30d,
        offers: item.offers,
      }));
      title = "cleaned_items.json";
      hint = "清洗、去重、打分后的前 3 条";
    } else {
      data = {
        command: `python -m pricehunter search "${result.meta.keyword}" --source demo --limit ${result.stats.raw_count} --json out.json --csv out.csv`,
        engine: result.meta.engine,
        adapter: result.meta.source,
        pipeline: ["collect", "clean", "dedupe", "score", "sort"],
        normalization: {
          price: "统一为两位小数",
          sales: "万 / 千 / + 归一化为整数",
          rating: "统一到 0–5 分",
        },
        outlier_rule: "IQR × 3",
        dedupe: "标题标准化指纹，保留最低价报价",
        scoring: {
          price: 0.46,
          sales: 0.29,
          rating: 0.25,
          labels: ["性价比首选 ≥78", "值得入手 ≥65", "中规中矩 ≥52", "谨慎比价 <52"],
        },
        trend_window_days: 30,
      };
      title = "pipeline.config.json";
      hint = "本次运行的参数与口径";
    }
    $("#codeTitle").textContent = title;
    $("#codeHint").textContent = hint;
    $("#codeBody").innerHTML = highlightJSON(JSON.stringify(data, null, 2));
  }

  function renderAll(result) {
    renderKPIs(result);
    renderStages(result);
    renderRecommendations(result);
    renderFilters(result);
    renderTable(result);
    renderTrend(result);
    renderBands(result);
    renderData(result);
    $("#noticeText").textContent = `当前结果由「${
      result.meta.engine === "python" ? "Python 流水线" : "浏览器同构引擎"
    }」生成，关键词「${result.meta.keyword}」。${
      result.meta.engine === "python"
        ? "数据源为内置确定性模拟适配器，不代表真实商品与价格。"
        : "商品、店铺、价格与链接均为模拟数据，仅用于演示清洗、去重、排序与推荐逻辑。"
    }`;
  }

  /* ------------------------------------------------------------------ */
  /* run                                                                 */
  /* ------------------------------------------------------------------ */

  async function runSearch(keyword, options = {}) {
    if (state.running) return;
    keyword = String(keyword || "").trim();
    if (!keyword) {
      toast("请输入商品关键词");
      $("#keyword").focus();
      return;
    }

    state.running = true;
    setRunning(true);
    clearLog();
    addLog(`$ python -m pricehunter search "${keyword}" --source demo --limit 28`, "cmd");

    let result = null;
    if (state.source === "api") {
      if (!state.pythonAvailable) {
        addLog("! 本地 Python 服务未连接，改用浏览器内置引擎", "warn");
      } else {
        addLog("› POST /api/search  (source=demo)", "info");
        try {
          const response = await fetch("/api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ keyword, source: "demo", limit: 28 }),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `HTTP ${response.status}`);
          }
          result = await response.json();
          addLog("✓ Python 流水线返回结构化结果", "ok");
        } catch (error) {
          addLog(`! ${error.message}，回退浏览器引擎`, "warn");
          toast("Python 服务不可用，已回退内置引擎");
          state.pythonAvailable = false;
          updateEnginePill(false, "内置引擎 · Python 服务不可用");
        }
      }
    }

    if (!result) {
      await wait(160);
      result = analyze(generateDemo(keyword, 28), keyword, "browser");
    }

    await animateLogs(result);
    state.result = result;
    state.keyword = keyword;
    state.platform = "全部";
    renderAll(result);

    state.running = false;
    setRunning(false);
    if (!options.initial) toast(`采集完成：${result.stats.final_count} 条有效商品`);
  }

  /* ------------------------------------------------------------------ */
  /* engine detection + events                                           */
  /* ------------------------------------------------------------------ */

  function updateEnginePill(online, text) {
    $("#enginePill").classList.toggle("online", Boolean(online));
    $("#engineText").textContent = text;
  }

  async function detectEngine() {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (!response.ok) throw new Error("offline");
      const payload = await response.json();
      state.pythonAvailable = true;
      updateEnginePill(true, `Python ${payload.python || ""} · 已连接`);
      state.source = "api";
      $("#sourceSelect").value = "api";
    } catch (error) {
      state.pythonAvailable = false;
      updateEnginePill(false, "离线演示引擎");
    }
  }

  function bindEvents() {
    $("#searchForm").addEventListener("submit", (event) => {
      event.preventDefault();
      runSearch($("#keyword").value);
    });

    $$(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const keyword = chip.dataset.keyword;
        $("#keyword").value = keyword;
        runSearch(keyword);
      });
    });

    $("#sourceSelect").addEventListener("change", (event) => {
      state.source = event.target.value;
      if (state.source === "api" && !state.pythonAvailable) {
        toast("未检测到本地服务，请先运行 python -m pricehunter serve");
      }
    });

    $("#platformFilters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-platform]");
      if (!button || !state.result) return;
      state.platform = button.dataset.platform;
      renderFilters(state.result);
      renderTable(state.result);
    });

    $$(".compare-table th.sortable").forEach((header) => {
      header.addEventListener("click", () => {
        const key = header.dataset.sort;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          state.sortDir = key === "sales" || key === "rating" || key === "value_score" ? "desc" : "asc";
        }
        if (state.result) {
          renderFilters(state.result);
          renderTable(state.result);
        }
      });
    });

    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.tab = tab.dataset.tab;
        $$(".tab").forEach((item) => {
          const active = item === tab;
          item.classList.toggle("active", active);
          item.setAttribute("aria-selected", String(active));
        });
        if (state.result) renderData(state.result);
      });
    });

    $("#copyBtn").addEventListener("click", async () => {
      const text = $("#codeBody").textContent;
      try {
        await navigator.clipboard.writeText(text);
        toast("已复制到剪贴板");
      } catch (error) {
        const range = document.createRange();
        range.selectNodeContents($("#codeBody"));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        toast("已选中代码，请按 Ctrl/Cmd + C 复制");
      }
    });

    $("#scrollTableBtn").addEventListener("click", () => {
      $("#compareSection").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function init() {
    bindEvents();
    await detectEngine();
    await runSearch("无线蓝牙耳机", { initial: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
