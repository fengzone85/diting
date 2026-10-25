'use strict';
// ============================================================
// S5：受控端二进制签名中继（对齐 monitor src/main.rs:222-340）
//
// 目标：电信出口等连不上 GitHub 的节点，从 diting 服务端拉 agent 二进制。
// 方向仍是「agent 出站 → 服务端」：零入站规则不破，无需在节点开放任何端口。
//
// 时序（照抄 monitor，**不可简化**）：
//   整包读入内存 → 验签 → 架构校验 → 通过后才发响应头。
//   绝不边下边发：未验签的字节一旦流出服务端，中继就从「校验点」变成「攻击面」。
//
// 信任模型：
//   - 签名 ed25519，公钥是**编译期常量**（本文件 PUBLIC_KEY_B64），不允许 env 覆盖；
//     轮换 = 改这一行 + 换 CI secret，随发版一起走。
//   - 资产 URL 由「白名单查表」得到，`:os/:arch` 参数**绝不参与拼 URL**（防 SSRF/路径穿越）。
//   - 只缓存验签通过的产物，按「具体 tag」为键（滚动 latest 不解析 tag 就缓存会长期发旧版）。
//
// 容量/并发（monitor 同款常量）：
//   并发槽 4（等槽 30s → 503，安装脚本会回落 GitHub 重试）；二进制 ≤16MB、签名 ≤64B；
//   响应头死线 55s（tag 解析 + 下载 + 验签 + 架构校验的总预算）；传输死线 180s。
// ============================================================

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rateLimitTouch, bucketKey } = require('./ratelimit');

const OWNER = 'fengzone85';
const REPO = 'diting';
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
const DL_BASE = `https://github.com/${OWNER}/${REPO}/releases`;

// :os/:arch → 资产名。白名单查表，参数不进 URL。
const ASSETS = {
  'linux/amd64': 'diting-agent-linux-amd64',
  'linux/arm64': 'diting-agent-linux-arm64',
  'windows/amd64': 'diting-agent-windows-amd64.exe',
};

// ed25519 公钥（raw 32 字节，base64）。轮换随发版；严禁 env 覆盖。
const PUBLIC_KEY_B64 = 'cejDXs72xHZx2/CVN4N8BYNJJp3rk2yI5Dx2dSk8tZU=';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SIG_BYTES = 64;
const MAX_SHA_BYTES = 4096;
const SLOTS = 4;
let slotWaitMs = 30000; // 测试可调小（见 _test.setSlotWaitMs）
const HEADER_DEADLINE_MS = 55000; // 到发出响应头为止（含验签与架构校验）
const XFER_DEADLINE_MS = 180000;  // 单次上游请求死线
const TAG_TTL_MS = 6 * 3600 * 1000;
const API_TIMEOUT_MS = 20000;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const RELAY_RATE_WINDOW = 60000;
const RELAY_RATE_MAX = 20; // 每 IP 每分钟：安装脚本最多拉 2 次（二进制 + sha256）

class RelayError extends Error {
  constructor(status, code, detail) {
    super(detail || code);
    this.status = status;
    this.code = code;
  }
}

// 原始 ed25519 公钥 → SPKI DER（Node crypto 只认 SPKI/DER）
function spkiFromRaw(raw) {
  return Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
}

// crypto.verify 只接受 KeyObject（DER Buffer 会被当 PEM 解析而失败），这里统一转成 KeyObject。
let verifyKey = crypto.createPublicKey({
  key: spkiFromRaw(Buffer.from(PUBLIC_KEY_B64, 'base64')),
  format: 'der',
  type: 'spki',
});

// 可注入 fetcher（测试用）：async (url, timeoutMs) => {status, body:Buffer, headers}
let fetcher = null;
let enabled = process.env.RELAY_ENABLED === '1'; // 默认关：灰度期显式开

const CACHE_DIR = process.env.RELAY_CACHE_DIR || path.join(os.tmpdir(), 'diting-relay');

// ---- 架构校验 ---------------------------------------------------------------
// 用「机器头」而不是 buildinfo 里的 GOOS/GOARCH：Go 的 buildinfo 稳定字段是
// GoVersion 与 module settings（GOOS/GOARCH 只是 settings 列表里的普通项，位置
// 随模块/构建参数变化），而 ELF e_machine / PE Machine 是权威且两种格式都覆盖
// （monitor 只查 ELF，diting 的 Windows 产物必须也查）。
// 读不出机器类型 = 不认识的格式 → fail closed（拒发），绝不「放过」。
function machineOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) return null;
  // ELF: e_machine @ 18（LE）
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const m = buf.readUInt16LE(18);
    if (m === 0x003e) return { os: 'linux', arch: 'amd64' };
    if (m === 0x00b7) return { os: 'linux', arch: 'arm64' };
    return null;
  }
  // PE: 'MZ' → e_lfanew @ 0x3c → 'PE\0\0' → Machine @ +4
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const off = buf.readUInt32LE(0x3c);
    if (off + 6 > buf.length) return null;
    if (buf.readUInt32LE(off) !== 0x00004550) return null;
    const m = buf.readUInt16LE(off + 4);
    if (m === 0x8664) return { os: 'windows', arch: 'amd64' };
    if (m === 0xaa64) return { os: 'windows', arch: 'arm64' };
    return null;
  }
  return null;
}

// ---- 并发槽 -----------------------------------------------------------------
let inFlight = 0;
const waiters = [];

function acquireSlot() {
  return new Promise((resolve, reject) => {
    if (inFlight < SLOTS) {
      inFlight++;
      return resolve();
    }
    const entry = { resolve, timer: null };
    // 超时必须把自己从队列里摘掉：否则 releaseSlot() 会把槽「移交」给一个已经
    // reject 的死 promise —— inFlight 保持高位却无人使用，等于泄漏一个槽。
    entry.timer = setTimeout(() => {
      const i = waiters.indexOf(entry);
      if (i >= 0) waiters.splice(i, 1);
      reject(new RelayError(503, 'relay_busy', 'no slot within 30s'));
    }, slotWaitMs);
    waiters.push(entry);
  });
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(); // 槽直接移交，inFlight 不变
    return;
  }
  inFlight--;
}

// ---- tag 解析 ---------------------------------------------------------------
let tagCache = { tag: null, at: 0 };

async function resolveTag() {
  const now = Date.now();
  if (tagCache.tag && now - tagCache.at < TAG_TTL_MS) return tagCache.tag;

  // 1) GitHub API（最直接，能拿到 tag_name）
  let tag = null;
  try {
    const r = await fetchUrl(`${API_BASE}/releases/latest`, API_TIMEOUT_MS);
    if (r.status === 200) {
      const j = JSON.parse(r.body.toString('utf8'));
      if (j && typeof j.tag_name === 'string' && j.tag_name) tag = j.tag_name;
    }
  } catch (e) { /* 回落 302 解析 */ }

  // 2) 回落：HEAD latest/download/<已知资产>，从 Location 里解析 /download/<tag>/
  if (!tag) {
    try {
      const r = await fetchUrl(`${DL_BASE}/latest/download/diting-agent-linux-amd64.sha256`, API_TIMEOUT_MS, { redirect: 'manual' });
      const loc = (r.headers && (r.headers.location || r.headers.Location)) || '';
      if (r.status >= 300 && r.status < 400 && loc) {
        const m = /\/releases\/download\/([^/]+)\//.exec(loc);
        if (m) tag = m[1];
      }
    } catch (e) { /* 上游不可达 */ }
  }

  if (tag) tagCache = { tag, at: now };
  return tag;
}

// redirect: 'follow'（默认，资产下载要跟随 GitHub → CDN 的 302）或
// 'manual'（仅 tag 解析时需要读 Location 头）。
function fetchUrl(url, timeoutMs, opts) {
  const f = fetcher || defaultFetcher;
  return f(url, timeoutMs, opts);
}

const defaultFetcher = async (url, timeoutMs, opts) => {
  if (typeof fetch !== 'function') {
    throw new RelayError(503, 'fetch_unavailable', 'Node 18+ required for upstream fetch');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      redirect: (opts && opts.redirect) || 'follow',
      signal: ctrl.signal,
    });
    const body = Buffer.from(await r.arrayBuffer());
    return { status: r.status, body, headers: Object.fromEntries(r.headers.entries()) };
  } finally {
    clearTimeout(timer);
  }
};

// ---- 磁盘缓存（只存验签通过产物；键含具体 tag）--------------------------------
function cacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 }); } catch (e) { /* 用默认 */ }
  return CACHE_DIR;
}

function cachePath(tag, name) {
  const safe = `${String(tag).replace(/[^A-Za-z0-9._-]/g, '_')}__${name}`;
  return path.join(cacheDir(), safe);
}

function cacheGet(tag, name) {
  try {
    const p = cachePath(tag, name);
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return fs.readFileSync(p);
  } catch (e) {
    return null;
  }
}

function cachePut(tag, name, buf) {
  try {
    fs.writeFileSync(cachePath(tag, name), buf, { mode: 0o600 });
    evictCache();
  } catch (e) {
    console.warn('[relay] cache write failed:', e.message);
  }
}

function evictCache() {
  try {
    const dir = cacheDir();
    const files = fs.readdirSync(dir)
      .map((f) => {
        try {
          const st = fs.statSync(path.join(dir, f));
          return { f, size: st.size, mtime: st.mtimeMs };
        } catch (e) { return null; }
      })
      .filter(Boolean);
    let total = files.reduce((s, x) => s + x.size, 0);
    if (total <= CACHE_MAX_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime);
    for (const x of files) {
      if (total <= CACHE_MAX_BYTES) break;
      try {
        fs.unlinkSync(path.join(dir, x.f));
        total -= x.size;
      } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 缓存清理失败不影响服务 */ }
}

// ---- 主流程 -----------------------------------------------------------------
// 网络层失败（TypeError: fetch failed）重试：本机到 GitHub 出口**间歇性**超时
// （实测同一 URL 时通时断），重试成本远低于让安装脚本回落 GitHub。
// HTTP 状态错误不重试（4xx/5xx 重试无意义）；最终失败统一包成 502，别把
// TypeError 漏成 500（调用方无法区分「上游挂了」和「服务端 bug」）。
async function fetchWithRetry(url, timeoutMs, opts, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchUrl(url, timeoutMs, opts);
    } catch (e) {
      if (e instanceof RelayError) throw e;
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw new RelayError(502, 'upstream_unreachable', String(lastErr && lastErr.message || lastErr));
}

async function prepare(key, wantSha) {
  const deadline = Date.now() + HEADER_DEADLINE_MS;
  const asset = ASSETS[key];
  // 单次上游请求死线：不超过剩余总预算，也不超过传输死线
  const remaining = () => Math.max(1000, Math.min(deadline - Date.now(), XFER_DEADLINE_MS));

  const tag = await resolveTag();
  if (!tag) throw new RelayError(502, 'release_resolve_failed', 'cannot resolve current release tag');

  const name = wantSha ? `${asset}.sha256` : asset;
  const hit = cacheGet(tag, name);
  if (hit) return { tag, buf: hit, fromCache: true };

  const res = await fetchWithRetry(`${DL_BASE}/download/${encodeURIComponent(tag)}/${name}`, remaining());
  if (res.status === 404) throw new RelayError(404, 'asset_not_found', `${name} not in ${tag}`);
  if (res.status !== 200 || !res.body || !res.body.length) {
    throw new RelayError(502, 'upstream_failed', `upstream status ${res.status}`);
  }

  if (wantSha) {
    if (res.body.length > MAX_SHA_BYTES) throw new RelayError(502, 'sha_too_large');
    const sha = res.body.toString('utf8').trim().split(/\s+/)[0];
    if (!/^[0-9a-fA-F]{64}$/.test(sha)) throw new RelayError(502, 'sha_malformed');
    const buf = Buffer.from(sha);
    cachePut(tag, name, buf);
    return { tag, buf, fromCache: false };
  }

  if (res.body.length > MAX_BYTES) throw new RelayError(502, 'too_large');

  // 1) 验签（整包已在内存）
  const sigRes = await fetchWithRetry(`${DL_BASE}/download/${encodeURIComponent(tag)}/${name}.sig`, remaining());
  if (sigRes.status !== 200 || !sigRes.body || !sigRes.body.length) {
    throw new RelayError(502, 'sig_unavailable', `signature fetch status ${sigRes.status}`);
  }
  if (sigRes.body.length > MAX_SIG_BYTES) throw new RelayError(502, 'sig_too_large');

  let ok = false;
  try {
    ok = crypto.verify(null, res.body, verifyKey, sigRes.body);
  } catch (e) {
    ok = false; // 公钥/签名格式异常一律视为不通过
  }
  if (!ok) throw new RelayError(422, 'signature_invalid');

  // 2) 架构校验（fail closed）
  const machine = machineOf(res.body);
  if (!machine) throw new RelayError(422, 'arch_unknown', 'cannot read machine header');
  if (`${machine.os}/${machine.arch}` !== key) {
    throw new RelayError(415, 'arch_mismatch', `binary is ${machine.os}/${machine.arch}, want ${key}`);
  }

  cachePut(tag, name, res.body);
  return { tag, buf: res.body, fromCache: false };
}

const router = express.Router();

// 中继端点限流：安装脚本一次安装最多 2 次请求（二进制 + sha256），20/min 足够宽松，
// 但足以防止把它当成「免登录大文件下载 CDN」滥用。
const relayHits = new Map();
const relayRateLimit = (req, res, next) => {
  if (!rateLimitTouch(relayHits, bucketKey(req.ip || req.socket.remoteAddress), RELAY_RATE_WINDOW, RELAY_RATE_MAX)) {
    return res.status(429).json({ error: 'too many requests' });
  }
  next();
};

router.get('/releases/agent/:os/:arch', relayRateLimit, async (req, res) => {
  if (!enabled) {
    return res.status(503).json({
      error: 'relay_disabled',
      hint: 'set RELAY_ENABLED=1 on the server, or point the installer at GitHub releases',
    });
  }
  const key = `${req.params.os}/${req.params.arch}`;
  if (!ASSETS[key]) {
    return res.status(400).json({ error: 'unsupported_platform', supported: Object.keys(ASSETS) });
  }
  const wantSha = req.query.format === 'sha256';

  let slot;
  try {
    slot = await acquireSlot();
  } catch (e) {
    return res.status(503).json({ error: e.code || 'relay_busy', hint: 'retry or fall back to GitHub' });
  }
  try {
    const out = await prepare(key, wantSha);
    res.setHeader('X-Diting-Relay-Tag', out.tag);
    res.setHeader('X-Diting-Relay-Cache', out.fromCache ? 'hit' : 'miss');
    if (wantSha) {
      res.type('text/plain').send(out.buf.toString('utf8'));
    } else {
      res.type('application/octet-stream').send(out.buf);
    }
  } catch (e) {
    const status = e instanceof RelayError ? e.status : 500;
    if (status >= 500) console.error(`[relay] ${key} failed:`, e.message);
    res.status(status).json({ error: e.code || 'relay_failed', detail: e.message });
  } finally {
    releaseSlot();
    void slot;
  }
});

// ---- 测试/运维钩子 -----------------------------------------------------------
const _test = {
  setFetcher(fn) { fetcher = fn; },
  setVerifyKey(raw32) {
    verifyKey = crypto.createPublicKey({ key: spkiFromRaw(raw32), format: 'der', type: 'spki' });
  },
  setEnabled(v) { enabled = !!v; },
  setSlotWaitMs(ms) { slotWaitMs = ms; },
  resetRateLimit() { relayHits.clear(); },
  // 并发槽原语：单测直接验证「占满→等槽超时→释放后移交」，无需打 HTTP
  acquireSlot,
  releaseSlot,
  slotsInFlight: () => inFlight,
  resetTagCache() { tagCache = { tag: null, at: 0 }; },
  machineOf,
  spkiFromRaw,
  cacheDir,
  RelayError,
};

module.exports = { router, ASSETS, _test,
  // 供「受控端一键分发」复用：取官方 release 资产（**已验签 + 已做架构校验**）。
  // 复用而非另写 GitHub 客户端，是为了不重复实现签名校验这一段安全逻辑。
  prepare, resolveTag };
