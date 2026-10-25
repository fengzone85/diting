'use strict';
// S5：签名中继单测。fetcher 与验签公钥均可注入，不触网、不依赖真实 Release。
//
// 覆盖：验签通过 / 签名错误 / 架构不符 / 资产缺失 / 槽耗尽 503 /
//       缓存命中与 tag 更新 / sha256 通道 / 平台白名单 / 默认关闭。
process.env.PORT = '0';
process.env.DB_PATH = '/tmp/diting-relay-test.db';
process.env.ADMIN_TOKEN = 'relay-test-admin-token-0123456789';
process.env.ADMIN_ALLOW_HTTP = '1';

const { test, after, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('node:fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'diting-relay-cache-'));
// 必须在 require agent-relay 之前设置：模块在加载时读取该变量
process.env.RELAY_CACHE_DIR = CACHE;

const relay = require('../src/agent-relay');
const { app, server } = require('../server');

// ---- 构造测试用资产 ---------------------------------------------------------
// 真实 ELF/PE 头（架构校验只看机器头）+ 可签名内容
function elf(arch) {
  const b = Buffer.alloc(4096, 0);
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46;
  b.writeUInt16LE(arch === 'arm64' ? 0x00b7 : 0x003e, 18); // e_machine
  b.write('diting-agent-test-payload', 64, 'utf8');
  return b;
}

function pe(arch) {
  const b = Buffer.alloc(4096, 0);
  b[0] = 0x4d; b[1] = 0x5a;                        // 'MZ'
  const peOff = 0x80;
  b.writeUInt32LE(peOff, 0x3c);                    // e_lfanew
  b.writeUInt32LE(0x00004550, peOff);              // 'PE\0\0'
  b.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, peOff + 4); // Machine
  b.write('diting-agent-test-payload', 256, 'utf8');
  return b;
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

function sign(buf) {
  return crypto.sign(null, buf, privateKey);
}

// ---- 可控 fetcher -----------------------------------------------------------
let tag = 'agent-go-v9.9.9';
let calls = [];
let handler = null; // (url) => {status, body, headers} | null

const fakeFetcher = async (url) => {
  calls.push(url);
  if (handler) {
    // 必须 await：handler 可能是 async 且返回 null（表示「不覆盖，走默认分支」），
    // 直接 `if (r)` 会把 Promise 当真值返回，随后 r.status 访问 null 抛错。
    const r = await handler(url);
    if (r) return r;
  }
  if (url.endsWith('/releases/latest')) {
    return { status: 200, body: Buffer.from(JSON.stringify({ tag_name: tag })), headers: {} };
  }
  if (url.includes('/download/')) {
    const name = url.split('/').pop();
    if (name.endsWith('.sha256')) {
      return { status: 200, body: Buffer.from('a'.repeat(64) + '  diting-agent\n'), headers: {} };
    }
    if (name.endsWith('.sig')) {
      const asset = decodeURIComponent(url.split('/').slice(-2)[0]);
      const buf = asset.includes('arm64') ? elf('arm64') : (asset.startsWith('diting-agent-windows') ? pe('amd64') : elf('amd64'));
      return { status: 200, body: sign(buf), headers: {} };
    }
    if (name === 'diting-agent-linux-amd64') return { status: 200, body: elf('amd64'), headers: {} };
    if (name === 'diting-agent-linux-arm64') return { status: 200, body: elf('arm64'), headers: {} };
    if (name === 'diting-agent-windows-amd64.exe') return { status: 200, body: pe('amd64'), headers: {} };
    return { status: 404, body: Buffer.alloc(0), headers: {} };
  }
  return { status: 404, body: Buffer.alloc(0), headers: {} };
};

before(() => {
  relay._test.setFetcher(fakeFetcher);
  relay._test.setVerifyKey(rawPub);
  relay._test.setEnabled(true);
});

// 每个用例都从「干净缓存 + 干净 tag + 干净上游计数」开始：否则前一个用例
// 验签通过的产物会被后续用例命中，导致「签名错误」根本走不到验签分支。
beforeEach(() => {
  for (const f of fs.readdirSync(CACHE)) fs.unlinkSync(path.join(CACHE, f));
  relay._test.resetTagCache();
  // 中继限流表跨用例累积：不清会把后续请求全 429，根本到不了 fetcher
  relay._test.resetRateLimit();
  handler = null;
  calls = [];
});

after(async () => {
  relay._test.setEnabled(false);
  relay._test.setFetcher(null);
  relay._test.resetTagCache();
  fs.rmSync(CACHE, { recursive: true, force: true });
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

const get = (p) => request(app).get(p);

test('S5 验签通过：整包验签 + 架构校验后才发字节，并回带 tag', async () => {
  const r = await get('/api/releases/agent/linux/amd64');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['x-diting-relay-tag'], 'agent-go-v9.9.9');
  assert.strictEqual(r.headers['x-diting-relay-cache'], 'miss');
  assert.ok(Buffer.from(r.body).length > 0);
});

test('S5 架构不符：请求 linux/arm64 但上游是 x86-64 → 415 且不落缓存', async () => {
  // 让 arm64 资产返回 amd64 二进制（默认 handler 已经按 name 区分，这里显式覆盖）
  handler = (url) => {
    if (url.endsWith('diting-agent-linux-arm64')) return { status: 200, body: elf('amd64'), headers: {} };
    if (url.endsWith('diting-agent-linux-arm64.sig')) return { status: 200, body: sign(elf('amd64')), headers: {} };
    return null;
  };
  const r = await get('/api/releases/agent/linux/arm64');
  assert.strictEqual(r.status, 415);
  assert.strictEqual(r.body.error, 'arch_mismatch');
  handler = null;
});

test('S5 签名错误/缺失：拒发（422/502），且不写缓存', async () => {
  handler = (url) => {
    if (url.endsWith('.sig')) return { status: 200, body: sign(elf('arm64')), headers: {} }; // 签的是另一个文件
    return null;
  };
  const r = await get('/api/releases/agent/linux/amd64');
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.error, 'signature_invalid');
  handler = (url) => (url.endsWith('.sig') ? { status: 404, body: Buffer.alloc(0), headers: {} } : null);
  const r2 = await get('/api/releases/agent/linux/amd64');
  assert.strictEqual(r2.status, 502);
  assert.strictEqual(r2.body.error, 'sig_unavailable');
  handler = null;
});

test('S5 资产缺失：404，不猜、不回落旧版', async () => {
  handler = (url) => (url.endsWith('diting-agent-windows-amd64.exe') ? { status: 404, body: Buffer.alloc(0), headers: {} } : null);
  const r = await get('/api/releases/agent/windows/amd64');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'asset_not_found');
  handler = null;
});

test('S5 缓存命中：同 tag 第二次不再打上游；tag 变更后重新拉取', async () => {
  calls = [];
  await get('/api/releases/agent/linux/amd64');
  const first = calls.length;
  assert.ok(first > 0, '首次必须打上游');

  calls = [];
  const r2 = await get('/api/releases/agent/linux/amd64');
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.headers['x-diting-relay-cache'], 'hit');
  assert.strictEqual(calls.filter((u) => u.includes('/download/')).length, 0, '命中缓存不得再打下载上游');

  // 新 tag：缓存键变化 → 必须重新下载并验签
  tag = 'agent-go-v1.0.0';
  relay._test.resetTagCache();
  const r3 = await get('/api/releases/agent/linux/amd64');
  assert.strictEqual(r3.status, 200);
  assert.strictEqual(r3.headers['x-diting-relay-tag'], 'agent-go-v1.0.0');
  assert.strictEqual(r3.headers['x-diting-relay-cache'], 'miss');
  tag = 'agent-go-v9.9.9';
  relay._test.resetTagCache();
});

test('S5 sha256 通道：?format=sha256 返回纯文本哈希', async () => {
  const r = await get('/api/releases/agent/linux/amd64?format=sha256');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /^[0-9a-f]{64}$/);
});

test('S5 平台白名单：只接受 linux/windows × amd64/arm64（未发布的组合也拒）', async () => {
  for (const p of ['darwin/amd64', 'linux/386', 'windows/arm', 'linux/amd64%2F..%2F..%2Fetc%2Fpasswd']) {
    const r = await get(`/api/releases/agent/${p}`);
    assert.strictEqual(r.status, 400, `${p} 应被拒`);
  }
  // 白名单只有三个「已发布」组合：windows/arm64 直接 400，不会走到上游
  const r = await get('/api/releases/agent/windows/arm64');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'unsupported_platform');
});

test('S5 默认关闭：RELAY_ENABLED 未设置时 503，安装脚本回落 GitHub', async () => {
  relay._test.setEnabled(false);
  const r = await get('/api/releases/agent/linux/amd64');
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.body.error, 'relay_disabled');
  relay._test.setEnabled(true);
});

test('S5 并发槽：4 槽占满 → 第 5 个等槽超时 503；释放后槽移交给等待者', async () => {
  relay._test.setSlotWaitMs(50);
  assert.strictEqual(relay._test.slotsInFlight(), 0);

  // 占满 4 个槽
  for (let i = 0; i < 4; i++) await relay._test.acquireSlot();
  assert.strictEqual(relay._test.slotsInFlight(), 4);

  // 第 5 个：等槽超时 → RelayError(503, relay_busy)（HTTP 层据此回 503，安装脚本回落 GitHub）
  await assert.rejects(
    relay._test.acquireSlot(),
    (e) => e instanceof relay._test.RelayError && e.status === 503 && e.code === 'relay_busy',
  );

  // 释放一个槽 → 应立即移交给等待者（inFlight 不回升）
  const waiter = relay._test.acquireSlot();
  relay._test.releaseSlot();
  await waiter;
  assert.strictEqual(relay._test.slotsInFlight(), 4, '槽是移交而非新增');

  // 全部释放归零
  for (let i = 0; i < 4; i++) relay._test.releaseSlot();
  assert.strictEqual(relay._test.slotsInFlight(), 0);
  relay._test.setSlotWaitMs(30000);
});

test('S5 机器头识别：ELF/PE 与未知格式（fail closed）', () => {
  assert.deepStrictEqual(relay._test.machineOf(elf('amd64')), { os: 'linux', arch: 'amd64' });
  assert.deepStrictEqual(relay._test.machineOf(elf('arm64')), { os: 'linux', arch: 'arm64' });
  assert.deepStrictEqual(relay._test.machineOf(pe('amd64')), { os: 'windows', arch: 'amd64' });
  assert.strictEqual(relay._test.machineOf(Buffer.from('not a binary at all')), null);
  assert.strictEqual(relay._test.machineOf(Buffer.alloc(8, 0)), null);
});
