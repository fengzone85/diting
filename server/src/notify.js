'use strict';
// ============================================================
// S1/F2：统一通知投递（邮件 / Telegram / 通用 Webhook + 通知组路由）
//
// 设计要点：
//   1. 渠道与组每次投递时直接查库（组/渠道为个位数，开销可忽略）——
//      管理端修改即时生效，无需热重载钩子。
//   2. 内置 mail/telegram 的凭据仍读 notify_config（单一事实源）；
//      webhook 的 URL/方法/头/模板存 notify_channels.config。
//   3. Webhook 出站做 SSRF 防护：DNS 解析后钉 IP、私网/回环/保留段默认拒绝
//      （ALLOW_PRIVATE_WEBHOOK=1 显式放行内网自托管场景）、禁重定向、
//      http 需 ALLOW_INSECURE_WEBHOOK=1、禁止覆盖 Host/Content-Length 等头。
//   4. 同一 (agent, event) 的告警→恢复串行投递，保证顺序；链完成后清理 Map。
//   5. 单通道失败不影响其它通道；返回是否至少一个通道成功（供告警态回滚）。
// ============================================================
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const nodemailer = require('nodemailer');
const db = require('./db');

const ALLOW_INSECURE = process.env.ALLOW_INSECURE_WEBHOOK === '1';
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_WEBHOOK === '1';
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.NOTIFY_CONCURRENCY || 8)));
const WEBHOOK_TIMEOUT_MS = 10000;

// ---- IP 段判定（SSRF 防护）--------------------------------------------------
function isBlockedIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0) return true;                              // 0.0.0.0/8
  if (a === 10) return true;                             // 10/8
  if (a === 127) return true;                            // loopback
  if (a === 169 && b === 254) return true;               // link-local（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16/12
  if (a === 192 && b === 168) return true;               // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;      // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;  // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;   // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;    // TEST-NET-3
  if (a >= 224) return true;                             // multicast/reserved/broadcast
  return false;
}

function isBlockedIPv6(ip) {
  const s = String(ip).toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7);
    return net.isIPv4(v4) ? isBlockedIPv4(v4) : true;
  }
  if (/^f[cd]/.test(s)) return true;        // fc00::/7 ULA
  if (/^fe[89ab]/.test(s)) return true;     // fe80::/10 link-local
  if (/^ff/.test(s)) return true;           // multicast
  if (s.startsWith('2001:db8')) return true; // documentation
  if (s.startsWith('64:ff9b:')) return true; // NAT64
  return false;
}

function isBlockedIP(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isBlockedIPv4(ip);
  if (fam === 6) return isBlockedIPv6(ip);
  return true;
}

// 部分 DNS 会对 AAAA 查询返回 ::（或对 A 返回 0.0.0.0）这类不可路由的伪答案。
// 它们不是可用目标，也不应单独否决一个确实有公网地址的主机名。
function isUnspecifiedIP(ip) {
  return ip === '0.0.0.0' || String(ip).toLowerCase() === '::';
}

// 从 dns.lookup 的结果里选出要钉住的地址。
// - 默认（ALLOW_PRIVATE 未开）：忽略 unspecified 伪答案后，任一剩余地址受限即拒绝，
//   保留「多 A 记录混入私网」的严格策略；只剩伪答案时同样拒绝。
// - ALLOW_PRIVATE=1：放行私网，但仍优先选非 unspecified 地址（否则会连到 ::）。
function selectResolvedAddress(addrs, allowPrivate) {
  if (!addrs || !addrs.length) throw new Error('dns_empty');
  const usable = addrs.filter((a) => !isUnspecifiedIP(a.address));
  if (allowPrivate) return (usable.length ? usable : addrs)[0];
  if (!usable.length) throw new Error('blocked_target');
  if (usable.some((a) => isBlockedIP(a.address))) throw new Error('blocked_target');
  return usable[0];
}

function resolveHost(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return reject(new Error('dns_failed'));
      try {
        const picked = selectResolvedAddress(addrs, ALLOW_PRIVATE);
        resolve({ ip: picked.address, family: picked.family });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseTarget(urlStr, cfg) {
  let u;
  try { u = new URL(urlStr); } catch (e) { throw new Error('url_invalid'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme_invalid');
  if (u.protocol === 'http:' && !ALLOW_INSECURE) throw new Error('insecure_scheme');
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: `${u.pathname || '/'}${u.search || ''}`,
    method: String(cfg.method || 'POST').toUpperCase(),
    headers: (cfg.headers && typeof cfg.headers === 'object') ? cfg.headers : {},
    verify_tls: cfg.verify_tls !== false
  };
}

// 钉 IP 的 lookup：主机名仅用于 SNI/Host，DNS 重绑定无效。
// Node 20+ 默认开启 autoSelectFamily，会以 { all: true } 调用 lookup 并期望地址数组；
// 只返回单个字符串会触发 ERR_INVALID_IP_ADDRESS（IP 字面量不触发 lookup，故测试易漏）。
function pinnedLookup(ip, family) {
  return (_host, options, cb) => {
    if (options && options.all) return cb(null, [{ address: ip, family }]);
    return cb(null, ip, family);
  };
}

function requestOnce(target, body) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers = Object.assign({ 'User-Agent': 'diting-webhook/1.0' }, target.headers);
    if (target.method === 'POST' && body !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const opts = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: Number(target.port),
      path: target.path,
      method: target.method,
      headers,
      timeout: WEBHOOK_TIMEOUT_MS,
      rejectUnauthorized: target.verify_tls !== false,
      agent: false, // 不复用连接，避免跨目标 keep-alive
      // 钉 IP 的 lookup：主机名仅用于 SNI/Host，DNS 重绑定无效。
      lookup: pinnedLookup(target.ip, target.family)
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (data.length < 4096) data += chunk; });
      res.on('end', () => {
        const code = res.statusCode || 0;
        if (code >= 200 && code < 300) return resolve({ status: code });
        const e = new Error(`http_${code}`);
        e.retriable = code >= 500;
        reject(e);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      if (!e.retriable) e.retriable = true;
      reject(e);
    });
    if (target.method === 'POST' && body !== undefined) req.write(body);
    req.end();
  });
}

// ---- 模板渲染 --------------------------------------------------------------
function jsonEscape(v) {
  return JSON.stringify(String(v === undefined || v === null ? '' : v)).slice(1, -1);
}

function render(template, vars, mode) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    const v = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
    if (mode === 'json') return jsonEscape(v);
    if (mode === 'form') return encodeURIComponent(String(v === undefined || v === null ? '' : v));
    return String(v);
  });
}

const DEFAULT_BODY_JSON = '{"title":"{{title}}","message":"{{message}}","event":"{{event}}","agent":"{{agent}}","agent_id":"{{agent_id}}","time":"{{time}}"}';
const DEFAULT_BODY_FORM = 'title={{title}}&message={{message}}&event={{event}}&agent={{agent}}&agent_id={{agent_id}}&time={{time}}';

function buildRequestBody(cfg, vars) {
  if (String(cfg.method || 'POST').toUpperCase() === 'GET') return undefined;
  const tpl = cfg.body_template || (cfg.content_type === 'form' ? DEFAULT_BODY_FORM : DEFAULT_BODY_JSON);
  return render(tpl, vars, cfg.content_type === 'form' ? 'form' : 'json');
}

// ---- 内置通道：邮件 / Telegram ---------------------------------------------
let _mailCache = { fp: '', transporter: null };
function mailTransport() {
  const c = db.getNotifyConfig();
  if (!c.smtp_user || !c.smtp_pass) return null;
  const fp = JSON.stringify([c.smtp_host, c.smtp_port, c.smtp_secure, c.smtp_user, c.smtp_pass]);
  if (_mailCache.fp !== fp || !_mailCache.transporter) {
    _mailCache = {
      fp,
      transporter: nodemailer.createTransport({
        host: c.smtp_host || 'smtp.qq.com',
        port: Number(c.smtp_port || 465),
        secure: c.smtp_secure !== false,
        auth: { user: c.smtp_user, pass: c.smtp_pass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000
      })
    };
  }
  return _mailCache.transporter;
}

async function sendMail(text) {
  const c = db.getNotifyConfig();
  const transporter = mailTransport();
  if (!transporter) throw new Error('mail_not_configured');
  await transporter.sendMail({
    from: c.alert_from || c.smtp_user,
    to: c.alert_to || c.smtp_user,
    subject: text.subject,
    text: text.message
  });
  return true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const c = db.getNotifyConfig();
    if (!c.telegram_bot_token || !c.telegram_chat_id) return reject(new Error('telegram_not_configured'));
    const payload = JSON.stringify({
      chat_id: c.telegram_chat_id,
      text: `<b>${escapeHtml(text.subject)}</b>\n\n${escapeHtml(text.message)}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${c.telegram_bot_token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 15000
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const e = new Error(`telegram_http_${res.statusCode}`);
          e.retriable = res.statusCode >= 500;
          return reject(e);
        }
        resolve(true);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---- Webhook ---------------------------------------------------------------
async function sendWebhook(channel, text) {
  const cfg = channel.config || {};
  const target = parseTarget(cfg.url, cfg);
  const resolved = await resolveHost(target.hostname);
  target.ip = resolved.ip;
  target.family = resolved.family;
  const body = buildRequestBody(cfg, text.vars);
  try {
    await requestOnce(target, body);
    return true;
  } catch (e) {
    if (!e.retriable) throw e;
    await new Promise((r) => setTimeout(r, 500));
    // 重试重新解析（应对临时 DNS 故障），但仍逐地址校验。
    const again = await resolveHost(target.hostname);
    target.ip = again.ip;
    target.family = again.family;
    await requestOnce(target, body);
    return true;
  }
}

async function sendToChannel(channel, text) {
  switch (channel.type) {
    case 'mail': return sendMail(text);
    case 'telegram': return sendTelegram(text);
    case 'webhook': return sendWebhook(channel, text);
    default: throw new Error('unknown_channel_type');
  }
}

// ---- 事件投递 --------------------------------------------------------------
const EMOTICONS = {
  offline: '🔴', online: '🟢', cpu: '⚠️', mem: '⚠️', disk: '⚠️', temp: '🌡️',
  cert: '🔐', expire: '⏰', expired: '⛔', quota: '📊', traffic_untrusted: '❓',
  ai_daily: '🤖', login: '👤', system: 'ℹ️', test: '🧪'
};

function buildVars(event, ctx) {
  const now = new Date();
  return {
    event,
    title: ctx.subject || '',
    message: ctx.text || '',
    agent: ctx.agentName || '',
    agent_id: ctx.agentId || '',
    time: now.toISOString(),
    emoji: EMOTICONS[event] || 'ℹ️'
  };
}

async function deliverAll(event, ctx) {
  const channels = db.listEnabledChannelsForEvent(event);
  if (!channels.length) return false;
  const vars = buildVars(event, ctx);
  const text = { subject: ctx.subject || '', message: ctx.text || '', vars };
  let ok = false;
  for (let i = 0; i < channels.length; i += CONCURRENCY) {
    const batch = channels.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((ch) => sendToChannel(ch, text)));
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        ok = true;
      } else {
        // 只记录渠道名与错误类型，绝不打印 URL/请求头（可能含凭据）。
        console.error(`[notify] channel "${batch[idx].name}" failed: ${r.reason && r.reason.message}`);
      }
    });
  }
  return ok;
}

// 同一 (agent, event) 串行：保证「告警 → 恢复」的到达顺序。
// 链在完成后立即移除（内存有界：键空间 = 节点数 × 事件数）。
const chains = new Map();

function sendEvent(event, ctx) {
  const key = `${(ctx && ctx.agentId) || ''}|${event}`;
  const prev = chains.get(key) || Promise.resolve(false);
  const p = prev.catch(() => false).then(() => deliverAll(event, ctx || {}));
  chains.set(key, p);
  // deliverAll 不抛异常（内部全捕获），finally 仅做清理。
  p.then(() => {
    if (chains.get(key) === p) chains.delete(key);
  }, () => {
    if (chains.get(key) === p) chains.delete(key);
  });
  return p;
}

// 渠道状态：mail/telegram 还要求 notify_config 中确有凭据。
function notifyStatus() {
  const channels = db.listNotifyChannels();
  const c = db.getNotifyConfig();
  const enabled = channels.filter((ch) => ch.enabled);
  return {
    mail: enabled.some((ch) => ch.type === 'mail') && !!(c.smtp_user && c.smtp_pass),
    telegram: enabled.some((ch) => ch.type === 'telegram') && !!(c.telegram_bot_token && c.telegram_chat_id),
    webhook: enabled.filter((ch) => ch.type === 'webhook').length,
    channels: enabled.length,
    groups: db.listNotifyGroups().filter((g) => g.enabled).length
  };
}

// 单渠道测试（管理端「测试」按钮）。
async function testChannel(channelId) {
  const ch = db.getNotifyChannel(channelId);
  if (!ch) throw new Error('channel_not_found');
  if (!ch.enabled) throw new Error('channel_disabled');
  const vars = buildVars('test', { subject: '[diting] 测试消息', text: '这是一条测试消息，用于验证通知渠道是否配置正确。' });
  await sendToChannel(ch, { subject: vars.title, message: vars.message, vars });
  return true;
}

module.exports = {
  sendEvent,
  notifyStatus,
  testChannel,
  // 供测试与审计使用
  _internal: {
    isBlockedIP, resolveHost, selectResolvedAddress, render, buildRequestBody, parseTarget, pinnedLookup,
    pendingChains: () => chains.size
  }
};
