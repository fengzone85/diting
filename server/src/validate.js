'use strict';
// 上报负载校验逻辑（纯函数，无 I/O、无 DB 依赖），便于独立审计与单元测试。
const num = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
};
const optNum = (v, min, max) => (v === null || v === undefined) ? null : num(v, min, max);
const optInt = (v, min, max) => {
  const n = optNum(v, min, max);
  return n === null ? null : Math.floor(n);
};
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');

// 管理员自定义 CSS 清洗：仅放行样式能力，杜绝外联资源加载与脚本注入。
// 威胁模型（见安全审计 M-1）：admin 角色可写入 custom_css，需防止
//   - @import / @font-face 外链、字体指纹追踪
//   - url() 加载远程资源 / 数据外泄
//   - expression() / javascript: 等历史 XSS 向量
//   - behavior / -moz-binding 等危险属性
// 做法：先剥离外链与脚本向量，再逐条声明校验属性名，丢弃非法/危险项。
const CSS_MAX = 20000;
const CSS_DANGEROUS_PROP = /^(|-moz-)?(behavior|binding)$/i;
function sanitizeCss(input) {
  if (typeof input !== 'string') return '';
  let css = input.slice(0, CSS_MAX);
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');          // 注释
  css = css.replace(/@import\b[^;]*;?/gi, '');          // @import 外链
  css = css.replace(/@charset\b[^;]*;?/gi, '');         // @charset
  css = css.replace(/@namespace\b[^;]*;?/gi, '');       // @namespace
  css = css.replace(/@font-face\s*\{[^}]*\}/gi, '');    // @font-face 块（字体指纹）
  css = css.replace(/url\(\s*[^)]*\)/gi, '');           // 所有 url(...) 外链/数据
  css = css.replace(/expression\s*\(/gi, '');           // IE expression 向量
  const blocks = css.split('}');
  const out = [];
  for (const raw of blocks) {
    const t = raw.trim();
    if (!t) continue;
    const i = t.indexOf('{');
    if (i < 0) { out.push(t); continue; }               // 游离片段/at-rule 续接
    const selector = t.slice(0, i).trim();
    if (selector.startsWith('@')) { out.push(t + '}'); continue; } // @media/@keyframes：已去 url/字体，整体放行
    const decls = t.slice(i + 1).split(';')
      .map(s => s.trim()).filter(Boolean)
      .map((decl) => {
        const c = decl.indexOf(':');
        if (c < 0) return null;
        const prop = decl.slice(0, c).trim().toLowerCase();
        const value = decl.slice(c + 1).trim();
        if (!/^-?[a-z][a-z0-9-]*$/.test(prop)) return null;   // 非法属性名
        if (CSS_DANGEROUS_PROP.test(prop)) return null;       // 危险属性
        if (/javascript:|vbscript:|data:\s*(?!image\/)/i.test(value)) return null; // 危险值
        return decl;
      }).filter(Boolean);
    if (decls.length && selector) out.push(`${selector}{${decls.join(';')}}`);
  }
  return out.join(' ').slice(0, CSS_MAX);
}

// Report payload validation. Rejects malformed/implausible data.
const validateReport = (b) => {
  if (typeof b !== 'object' || b === null) return null;
  return {
    cpu: num(b.cpu, 0, 100),
    mem_used: num(b.mem_used, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    mem_total: num(b.mem_total, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    mem_pct: num(b.mem_pct, 0, 100),
    disk_used: num(b.disk_used, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    disk_total: num(b.disk_total, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    disk_pct: num(b.disk_pct, 0, 100),
    load1: num(b.load1, 0, 1e6),
    // CPU 核数（§9 T18）：1–1024 的整数；非法或缺省 → 0（"未上报"，不可当 1 用）
    cores: Math.floor(num(b.cores, 1, 1024) || 0),
    load5: num(b.load5, 0, 1e6),
    load15: num(b.load15, 0, 1e6),
    net_rx_rate: num(b.net_rx_rate, 0, 1e15),
    net_tx_rate: num(b.net_tx_rate, 0, 1e15),
    net_rx_month: num(b.net_rx_month, 0, 1e18),
    net_tx_month: num(b.net_tx_month, 0, 1e18),
    // P1 流量口径：绝对计数器与重置日仅 Go 端上报；缺字段=null（legacy），超限=null（退回 legacy 透传）。
    net_rx: optNum(b.net_rx, 0, Number.MAX_SAFE_INTEGER),
    net_tx: optNum(b.net_tx, 0, Number.MAX_SAFE_INTEGER),
    month_rotate: optInt(b.month_rotate, 0, 31),
    disk_r_rate: num(b.disk_r_rate, 0, 1e15),
    disk_w_rate: num(b.disk_w_rate, 0, 1e15),
    uptime: num(b.uptime, 0, 1e12),
    // temp: null means "no sensor" — allowed; otherwise clamp to a plausible range.
    temp: (b.temp === null || b.temp === undefined) ? null : num(b.temp, -50, 200),
    // 进程总数（仅计数，无进程明细；0 = 未采集/不可用；上限 10 万防异常负载）
    process_count: Math.floor(num(b.process_count, 0, 100000) || 0),
    // 审查 C-1/E2：受控端上报的实际上报间隔（秒）。0 = 未上报（老 agent）。
    // 服务端另有相邻 ts 中位数观测（db.observedIntervalSec）作交叉/回退源。
    interval: Math.floor(num(b.interval, 0, 86400) || 0),
    swap_used: num(b.swap_used, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    swap_total: num(b.swap_total, 0, 1024 * 1024 * 1024 * 1024 * 1024),
    swap_pct: num(b.swap_pct, 0, 100),
    // 网络质量自测结果（固定公共目标，Agent 本地写死，服务端不可下发）。
    // 校验为受控对象：键≤8、label≤24 字符，值含 ms(0..100000 或 null) 与 ok(bool)。
    probes: (() => {
      const p = b.probes;
      if (!p || typeof p !== 'object' || Array.isArray(p)) return '{}';
      const out = {};
      let n = 0;
      for (const k of Object.keys(p)) {
        if (n >= 8) break;
        if (typeof k !== 'string' || k.length > 24) continue;
        const v = p[k];
        if (!v || typeof v !== 'object') continue;
        const ms = (v.ms === null || v.ms === undefined) ? null : num(v.ms, 0, 100000);
        // loss 丢包率 0-100（对齐 Komari 延迟采集标准）；缺省视为 0
        const loss = (v.loss === null || v.loss === undefined) ? (v.ok === true ? 0 : 100) : Math.round(num(v.loss, 0, 100));
        out[k] = { ms, ok: v.ok === true, loss };
        n++;
      }
      return JSON.stringify(out);
    })(),
    os: str(b.os, 200),
    hostname: str(b.hostname, 200),
    // 多盘使用率（可选）：Agent 遍历 /proc/mounts 上报，每项含 mount/used/total/pct。
    // 宽松校验，非法项丢弃，最多 32 块盘，避免异常负载撑爆数据库。
    disks: (() => {
      const d = b.disks;
      if (!Array.isArray(d)) return '[]';
      const out = [];
      for (const it of d) {
        if (!it || typeof it !== 'object') continue;
        const mount = typeof it.mount === 'string' ? it.mount.slice(0, 200) : '';
        const used = num(it.used, 0, 1024 * 1024 * 1024 * 1024 * 1024);
        const total = num(it.total, 0, 1024 * 1024 * 1024 * 1024 * 1024);
        const pct = num(it.pct, 0, 100);
        if (used === null || total === null || pct === null) continue;
        out.push({ mount, used, total, pct: +pct.toFixed(2) });
        if (out.length >= 32) break;
      }
      return JSON.stringify(out);
    })()
  };
};

// ---- S1/F2：通知渠道/通知组校验（纯函数）----------------------------------
// 事件字典为单一事实源：notify.js 与前端（经 GET /admin/notify/events）同源。
// 说明：恢复通知与对应指标事件同组投递（如 CPU 恢复归 'cpu'），不设独立 'recovery'
// 事件——否则默认 '*' 组会对同一次恢复重复投递。
const NOTIFY_EVENTS = [
  'offline', 'online', 'cpu', 'mem', 'disk', 'temp', 'cert',
  'expire', 'expired', 'quota', 'traffic_untrusted', 'ai_daily', 'login', 'system', 'test', 'capacity'
];
const WEBHOOK_METHODS = ['GET', 'POST'];
const WEBHOOK_CONTENT_TYPES = ['json', 'form'];
// 禁止用户覆盖请求头：主机/长度/连接类头由客户端控制，覆盖会破坏请求或绕过限制。
const WEBHOOK_BLOCKED_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'expect', 'upgrade'
]);

function validateWebhookConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'config_required' };
  const url = typeof input.url === 'string' ? input.url.trim().slice(0, 2048) : '';
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url_invalid' };
  const method = String(input.method || 'POST').toUpperCase();
  if (!WEBHOOK_METHODS.includes(method)) return { ok: false, error: 'method_invalid' };
  const contentType = String(input.content_type || 'json').toLowerCase();
  if (!WEBHOOK_CONTENT_TYPES.includes(contentType)) return { ok: false, error: 'content_type_invalid' };
  // headers 接受对象或 "Key: Value" 行文本；非法/危险头静默丢弃，最多 10 条。
  let rawHeaders = input.headers;
  if (typeof rawHeaders === 'string') {
    const obj = {};
    for (const line of rawHeaders.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    rawHeaders = obj;
  }
  if (rawHeaders === undefined || rawHeaders === null) rawHeaders = {};
  if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) return { ok: false, error: 'headers_invalid' };
  const headers = {};
  let n = 0;
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (n >= 10) break;
    const key = String(k).trim();
    const val = String(v);
    if (!key || key.length > 64 || val.length > 512) continue;
    if (!/^[A-Za-z0-9-]+$/.test(key)) continue;
    if (WEBHOOK_BLOCKED_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = val;
    n++;
  }
  const bodyTemplate = typeof input.body_template === 'string' ? input.body_template.slice(0, 8000) : '';
  return {
    ok: true,
    config: { url, method, content_type: contentType, headers, body_template: bodyTemplate, verify_tls: input.verify_tls !== false }
  };
}

function validateNotifyChannelInput(body) {
  const b = body || {};
  const type = String(b.type || '').toLowerCase();
  if (!['mail', 'telegram', 'webhook'].includes(type)) return { ok: false, error: 'type_invalid' };
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 64) : '';
  if (!name) return { ok: false, error: 'name_required' };
  const enabled = b.enabled !== false;
  if (type !== 'webhook') {
    // 内置渠道凭据仍存 notify_config（单一事实源），渠道行不持配置。
    return { ok: true, value: { type, name, enabled, config: {} } };
  }
  const v = validateWebhookConfig(b.config);
  if (!v.ok) return v;
  return { ok: true, value: { type, name, enabled, config: v.config } };
}

function validateNotifyGroupInput(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 64) : '';
  if (!name) return { ok: false, error: 'name_required' };
  const raw = Array.isArray(b.events) ? b.events : [];
  const events = [...new Set(raw.map((e) => String(e)).filter((e) => e === '*' || NOTIFY_EVENTS.includes(e)))].slice(0, NOTIFY_EVENTS.length + 1);
  if (!events.length) return { ok: false, error: 'events_required' };
  const channelIds = (Array.isArray(b.channel_ids) ? b.channel_ids : [])
    .map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 100);
  return { ok: true, value: { name, events, enabled: b.enabled !== false, channel_ids: channelIds } };
}

// ---- S5/F10 主题：源 / short / manifest / 配置值 ---------------------------
const THEME_SHORT_RE = /^[A-Za-z0-9_-]+$/;
const THEME_CONFIG_TYPES = ['text', 'textarea', 'number', 'select', 'boolean', 'color'];

function validateThemeShort(short) {
  if (typeof short !== 'string' || !THEME_SHORT_RE.test(short) || short === 'default') {
    return { ok: false, error: 'short_invalid' };
  }
  return { ok: true, value: short };
}

function validateThemeMarketSource(input) {
  const b = input || {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 64) : '';
  if (!name) return { ok: false, error: 'name_required' };
  if (typeof b.url !== 'string' || b.url.length > 2048) return { ok: false, error: 'url_invalid' };
  let u;
  try { u = new URL(b.url); } catch (e) { return { ok: false, error: 'url_invalid' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'url_scheme_invalid' };
  if (u.username || u.password) return { ok: false, error: 'url_userinfo_forbidden' };
  if (!u.hostname) return { ok: false, error: 'url_invalid' };
  return { ok: true, value: { name, url: u.toString(), enabled: b.enabled !== false } };
}

const themeText = (v) => {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of ['zh_CN', 'zh', 'en', 'en_US']) {
      if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim();
    }
    for (const x of Object.values(v)) if (typeof x === 'string' && x.trim()) return x.trim();
  }
  return '';
};

/**
 * 严格校验 manifest（安装/导入时使用）。列表场景用 theme.readManifest 的容错解析。
 * 返回值中的 configuration 已做结构清洗，供 validateThemeConfig 使用。
 */
function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'manifest_invalid' };
  const short = String(raw.short || raw.id || '');
  const vs = validateThemeShort(short);
  if (!vs.ok) return { ok: false, error: 'short_invalid' };
  if (!themeText(raw.name)) return { ok: false, error: 'name_required' };

  const version = typeof raw.version === 'string' ? raw.version.slice(0, 64) : '';
  const diting = raw.diting && typeof raw.diting === 'object' ? raw.diting : {};
  const compatibility = typeof diting.compatibility === 'string' ? diting.compatibility.slice(0, 64) : '';

  let configuration = null;
  if (raw.configuration !== undefined && raw.configuration !== null) {
    const c = raw.configuration;
    if (typeof c !== 'object' || Array.isArray(c)) return { ok: false, error: 'configuration_invalid' };
    const type = String(c.type || 'managed');
    // 本轮只支持 managed：raw（主题自带 HTML）与 redirect 需要额外的渲染沙箱/站内路径校验。
    if (type !== 'managed') return { ok: false, error: 'configuration_type_unsupported' };
    const data = Array.isArray(c.data) ? c.data : [];
    if (data.length > 50) return { ok: false, error: 'configuration_too_many_fields' };
    const fields = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') return { ok: false, error: 'configuration_field_invalid' };
      const key = typeof item.key === 'string' ? item.key.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return { ok: false, error: 'configuration_field_key_invalid' };
      const ftype = THEME_CONFIG_TYPES.includes(item.type) ? item.type : 'text';
      const options = ftype === 'select'
        ? (Array.isArray(item.options) ? item.options : String(item.options || '').split(/[|,]/))
          .map((x) => String(x).trim()).filter(Boolean).slice(0, 50)
        : [];
      if (ftype === 'select' && !options.length) return { ok: false, error: 'configuration_field_options_required' };
      fields.push({
        key,
        name: themeText(item.name) || key,
        type: ftype,
        options,
        default: item.default !== undefined ? item.default : '',
        required: item.required === true,
        help: typeof item.help === 'string' ? item.help.slice(0, 500) : ''
      });
    }
    configuration = { type: 'managed', fields };
  }

  return {
    ok: true,
    value: {
      short,
      version,
      compatibility,
      needsRelaxedCsp: diting.needsRelaxedCsp === true,
      configuration
    }
  };
}

/** 把存储值与默认值合并成完整配置（GET 返回 / POST 落库都用它）。 */
function mergeThemeConfig(fields, stored) {
  const out = {};
  const src = stored && typeof stored === 'object' ? stored : {};
  for (const f of fields) {
    out[f.key] = Object.prototype.hasOwnProperty.call(src, f.key) ? src[f.key] : f.default;
  }
  return out;
}

/**
 * 服务端配置值校验：只接受 manifest 白名单内的 key，按类型收敛并限制长度。
 * 前端校验只是即时提示，这里才是边界。
 */
function validateThemeConfig(configuration, body) {
  if (!configuration || configuration.type !== 'managed') return { ok: false, error: 'not_configurable' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'config_invalid' };
  const byKey = new Map(configuration.fields.map((f) => [f.key, f]));
  const patch = {};
  for (const [k, raw] of Object.entries(body)) {
    const f = byKey.get(k);
    if (!f) return { ok: false, error: 'config_key_unknown' };
    if (f.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: 'config_value_invalid' };
      patch[k] = n;
    } else if (f.type === 'boolean') {
      patch[k] = raw === true || raw === 'true' || raw === 1 || raw === '1';
    } else if (f.type === 'select') {
      const s = String(raw);
      if (!f.options.includes(s)) return { ok: false, error: 'config_value_invalid' };
      patch[k] = s;
    } else {
      if (typeof raw !== 'string') return { ok: false, error: 'config_value_invalid' };
      if (raw.length > 2000) return { ok: false, error: 'config_value_too_long' };
      patch[k] = raw;
    }
    if (f.required && (patch[k] === '' || patch[k] === null || patch[k] === undefined)) {
      return { ok: false, error: 'config_value_required' };
    }
  }
  return { ok: true, value: patch };
}

// ---- 后台仪表盘布局（对齐 Komari 仪表盘布局模型）---------------------------
// 布局是有序数组，元素 = { id, width, height }：
//   id     卡片唯一键（白名单，顺序即渲染顺序）
//   width  compact | wide | full（标准 / 加宽 / 整行）
//   height short | normal | tall（精简 / 标准 / 加高）
// 空数组合法（用户把卡片全部移除，前端显示「暂无卡片」引导）；
// 非法元素整条丢弃而不报 400，避免历史脏数据把整份布局卡死。
const DASHBOARD_WIDGET_IDS = [
  // 单指标卡
  'total', 'online', 'offline', 'monthly_cost', 'remaining_value',
  'avg_cpu', 'avg_mem', 'db_size', 'public_nodes',
  // 复合卡（对齐 Komari：概览 / 资源 / 排行 / 流量 / 到期 / 网络 / 分组 / 快捷操作）
  'overview', 'capacity', 'cpu_rank', 'mem_rank', 'disk_rank',
  'traffic', 'expiry', 'ping', 'groups', 'shortcuts',
];
const DASHBOARD_WIDTHS = ['compact', 'wide', 'full'];
const DASHBOARD_HEIGHTS = ['short', 'normal', 'tall'];

function validateDashboardLayout(input) {
  if (!Array.isArray(input)) return { ok: false, error: 'layout_invalid' };
  const seen = new Set();
  const value = [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = item.id;
    if (typeof id !== 'string' || !DASHBOARD_WIDGET_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    value.push({
      id,
      width: DASHBOARD_WIDTHS.includes(item.width) ? item.width : 'compact',
      height: DASHBOARD_HEIGHTS.includes(item.height) ? item.height : 'short',
    });
  }
  return { ok: true, value };
}

module.exports = {
  num, str, validateReport, sanitizeCss,
  NOTIFY_EVENTS, validateWebhookConfig, validateNotifyChannelInput, validateNotifyGroupInput,
  validateThemeShort, validateThemeMarketSource, validateManifest, mergeThemeConfig, validateThemeConfig,
  DASHBOARD_WIDGET_IDS, DASHBOARD_WIDTHS, DASHBOARD_HEIGHTS, validateDashboardLayout
};
