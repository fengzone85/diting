'use strict';
// ============================================================
// D 阶段：受控端二进制 artifact + 一键批量分发
//
// 方案：dev-docs/AGENT_DISTRIBUTION_PLAN_2026-10-21.md §3（D.1–D.7）
//
// 覆盖：
//   1. artifact 上传：平台白名单、大小上限、空 body、去重（内容寻址）、
//      文件名由服务端生成（不含用户输入）、磁盘权限 0600；
//   2. 分发包生成：来源校验（artifact / release_url）、目标平台校验、
//      包内含 update.sh + 二进制 + sha256 + manifest + README；
//   3. 脚本内容红线：sha256 校验在替换之前、含回滚、**不写 agent.env / run_scheduled.bat**；
//   4. 一次性下载 token：可下载、**重放拒绝**、篡改签名拒绝、过期拒绝、无 token 拒绝；
//   5. 鉴权：管理端点需 admin 凭据；下载端点只认 token；
//   6. 审计留痕。
//
// 运行前提与其它服务端测试一致：PORT=0 / ADMIN_ALLOW_HTTP=1 /
// 测试专用 ADMIN_TOKEN / DB_PATH 指向 /tmp 临时库（绝不触碰生产 monitor.db）。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'agentdist-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-agent-distribution-test.db';
process.env.SESSION_SECRET = 'agentdist-session-secret-0123456789abcdef';
// 允许私网访问：release_url 路径要连本地测试服务器（SSRF 防护本身由 theme-market 的
// safeDownload 负责，这里只是为测试放开私网拦截开关）。
process.env.ALLOW_PRIVATE_WEBHOOK = '1';
// 允许 http（本地测试服务器是明文 http；生产默认只允许 https）。
process.env.ALLOW_INSECURE_WEBHOOK = '1';
// 隔离签名中继的磁盘缓存（否则会污染 /tmp/diting-relay，且命中缓存会绕过验签）
process.env.RELAY_CACHE_DIR = '/tmp/diting-agent-dist-relay-cache';
// 禁服真实通知：仓库 .env 的 SMTP 占位符会激活邮件通道并真实联网。
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const request = require('supertest');

// 系统 tar 是否可用（用于校验手写 tar 容器能否被 GNU tar 正确解析）。
// 真机验证教训：只用自己的解析器校验会漏掉 header 字段格式错误 ⇒ 必须让真 tar 读一遍。
function hasTar() {
  try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const distribution = require('../src/distribution');

db.setConfig('notify_config', JSON.stringify({ smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: '' }));

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN };
// 假的受控端二进制（内容随意，服务端只按字节流处理，不解析可执行文件格式）。
const FAKE_BIN = Buffer.concat([Buffer.from('\x7fELF\x02\x01\x01', 'latin1'), Buffer.alloc(2048, 7)]);
const FAKE_BIN_WIN = Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(2048, 9)]);

after(async () => {
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  if (fileServer) {
    try { fileServer.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
    try { fileServer.close(); } catch { /* 已关闭 */ }
  }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
  try { fs.rmSync(distribution.ARTIFACT_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(distribution.PKG_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  // relay 磁盘缓存必须清：缓存键是 (tag, 资产名)，命中缓存即视为已验签可信，
  // 残留会让下一次运行拿到旧资产（曾导致 official_sha_mismatch 的假失败）。
  try { fs.rmSync(process.env.RELAY_CACHE_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// release_url 路径的本地源服务器（只提供二进制内容）。
let fileServer = null;
let fileServerBase = '';
async function startFileServer() {
  if (fileServer) return fileServerBase;
  fileServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': FAKE_BIN.length });
    res.end(FAKE_BIN);
  });
  await new Promise((resolve) => fileServer.listen(0, '127.0.0.1', resolve));
  fileServerBase = `http://127.0.0.1:${fileServer.address().port}`;
  return fileServerBase;
}
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- 1. artifact 上传 --------------------------------------------------------

test('artifact：平台白名单 / 空 body', async () => {
  let res = await request(app)
    .post('/api/admin/agent-artifacts?platform=plan9')
    .set(ADMIN)
    .set('Content-Type', 'application/octet-stream')
    .send(FAKE_BIN);
  assert.strictEqual(res.status, 400, '非法平台必须拒绝');
  assert.strictEqual(res.body.error, 'invalid_platform');

  res = await request(app)
    .post('/api/admin/agent-artifacts?platform=linux-amd64')
    .set(ADMIN)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.alloc(0));
  assert.strictEqual(res.status, 400, '空 body 必须拒绝');
  assert.strictEqual(res.body.error, 'empty_body');
});

test('artifact：上传成功，文件名由服务端生成（内容寻址），磁盘权限 0600', async () => {
  const res = await request(app)
    .post('/api/admin/agent-artifacts?platform=linux-amd64&source_note=fork%20build')
    .set(ADMIN)
    .set('Content-Type', 'application/octet-stream')
    .send(FAKE_BIN);
  assert.strictEqual(res.status, 200);
  assert.match(res.body.artifact_id, /^art_[0-9a-f]{12}$/);
  assert.match(res.body.sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(res.body.platform, 'linux-amd64');
  assert.strictEqual(res.body.size, FAKE_BIN.length);
  assert.strictEqual(res.body.deduped, false);

  const row = db.getAgentArtifact(res.body.artifact_id);
  assert.ok(row, '库中应有该 artifact');
  assert.strictEqual(row.source_note, 'fork build');
  // 文件名 = sha256 + 扩展名，**不含任何用户输入**
  assert.strictEqual(row.filename, `${res.body.sha256}.bin`);
  const full = path.join(distribution.ARTIFACT_DIR, row.filename);
  const st = fs.statSync(full);
  assert.strictEqual(st.mode & 0o777, 0o600, 'artifact 文件权限应为 0600');
  assert.strictEqual(st.size, FAKE_BIN.length);
});

test('artifact：同内容重复上传去重（不产生第二条记录）', async () => {
  const res = await request(app)
    .post('/api/admin/agent-artifacts?platform=linux-amd64')
    .set(ADMIN)
    .set('Content-Type', 'application/octet-stream')
    .send(FAKE_BIN);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.deduped, true, '同内容应命中去重');
  const list = db.listAgentArtifacts().filter((a) => a.sha256 === res.body.sha256);
  assert.strictEqual(list.length, 1, '同 sha256 只应有一条记录');
});

test('artifact：列表与删除', async () => {
  let res = await request(app).get('/api/admin/agent-artifacts').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.list));

  const id = res.body.list[0].id;
  const filename = res.body.list[0].filename;
  res = await request(app).delete(`/api/admin/agent-artifacts/${id}`).set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(db.getAgentArtifact(id), null);
  assert.strictEqual(fs.existsSync(path.join(distribution.ARTIFACT_DIR, filename)), false, '磁盘文件应一并删除');

  res = await request(app).delete('/api/admin/agent-artifacts/art_not_exist').set(ADMIN);
  assert.strictEqual(res.status, 404);
});

// ---- 2. 分发包生成 ----------------------------------------------------------

async function uploadArtifact(platform, buf) {
  const res = await request(app)
    .post(`/api/admin/agent-artifacts?platform=${platform}`)
    .set(ADMIN)
    .set('Content-Type', 'application/octet-stream')
    .send(buf);
  assert.strictEqual(res.status, 200);
  return res.body;
}

test('分发包：目标平台 / 来源校验', async () => {
  let res = await request(app).post('/api/admin/agent-distribution').set(ADMIN)
    .send({ agent_ids: [], target: { os: 'plan9', arch: 'amd64' }, source: { kind: 'artifact' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'invalid_target_os');

  res = await request(app).post('/api/admin/agent-distribution').set(ADMIN)
    .send({ agent_ids: [], target: { os: 'linux', arch: 'sparc' }, source: { kind: 'artifact' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'invalid_target_arch');

  res = await request(app).post('/api/admin/agent-distribution').set(ADMIN)
    .send({ agent_ids: [], target: { os: 'linux', arch: 'amd64' }, source: { kind: 'ftp' } });
  assert.strictEqual(res.status, 400, '未支持的来源必须拒绝');
  assert.strictEqual(res.body.error, 'unsupported_source');

  res = await request(app).post('/api/admin/agent-distribution').set(ADMIN)
    .send({ agent_ids: [], target: { os: 'linux', arch: 'amd64' }, source: { kind: 'release_url', release_url: 'https://example.com/a', release_sha256: 'zz' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'invalid_release_sha256');
});

test('分发包：artifact 来源生成 tar.gz，内容完整（脚本/二进制/校验和/manifest）', async () => {
  const art = await uploadArtifact('linux-amd64', FAKE_BIN);
  const res = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: ['agt_demo'],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'artifact', artifact_id: art.artifact_id },
    expires_in_minutes: 30
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.body.pkg_id, /^pkg_[0-9a-f]{16}$/);
  assert.strictEqual(res.body.kind, 'tar.gz');
  assert.ok(res.body.one_time_token, '应返回一次性 token');
  assert.ok(res.body.commands.linux.includes('/download?t='), '命令应带一次性 token');
  assert.ok(res.body.commands.linux.includes('sudo sh ./update.sh'), 'Linux 命令应以 sh 调用脚本（不依赖可执行位）');
  assert.strictEqual(res.body.manifest.binary.sha256, art.sha256);
  assert.strictEqual(res.body.manifest.target.platform, 'linux-amd64');

  // 落盘校验：能解开 tar.gz，且内容齐全
  const pkgRow = db.getAgentDistribution(res.body.pkg_id);
  const raw = fs.readFileSync(path.join(distribution.PKG_DIR, pkgRow.filename));
  const tar = zlib.gunzipSync(raw);
  const names = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.slice(off, off + 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.slice(off + 124, off + 136).toString('utf8').replace(/[^0-7]/g, ''), 8) || 0;
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(names.includes('update.sh'), '包内应有 update.sh');
  assert.ok(names.includes('diting-agent'), '包内应有二进制');
  assert.ok(names.includes('diting-agent.sha256'), '包内应有校验和文件');
  assert.ok(names.includes('manifest.json'), '包内应有 manifest');
  assert.ok(names.includes('README.txt'), '包内应有 README');
});

test('分发包：Windows 目标生成 zip + update.ps1', async () => {
  const art = await uploadArtifact('windows-amd64', FAKE_BIN_WIN);
  const res = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: ['agt_win'],
    target: { os: 'windows', arch: 'amd64' },
    source: { kind: 'artifact', artifact_id: art.artifact_id }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.kind, 'zip');
  const pkgRow = db.getAgentDistribution(res.body.pkg_id);
  const buf = fs.readFileSync(path.join(distribution.PKG_DIR, pkgRow.filename));
  assert.strictEqual(buf.slice(0, 2).toString('latin1'), 'PK', '应为 zip');
  assert.ok(res.body.commands.windows.includes('Expand-Archive'));
});

test('分发包：artifact 平台与目标平台不匹配时拒绝；未知 artifact → 404', async () => {
  const art = await uploadArtifact('linux-amd64', FAKE_BIN);
  let res = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: [],
    target: { os: 'windows', arch: 'amd64' },
    source: { kind: 'artifact', artifact_id: art.artifact_id }
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'artifact_platform_mismatch');

  res = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: [],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'artifact', artifact_id: 'art_not_exist' }
  });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'artifact_not_found');
});

test('分发包：release_url 来源（服务端下载并强制校验 sha256）', async () => {
  const base = await startFileServer();
  const good = sha256hex(FAKE_BIN);

  // sha256 不匹配 → 拒绝，且不落库任何包
  let res = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: [],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'release_url', release_url: `${base}/agent.bin`, release_sha256: 'a'.repeat(64) }
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'release_sha256_mismatch');

  // sha256 匹配 → 生成成功，并转存为 artifact
  res = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: [],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'release_url', release_url: `${base}/agent.bin`, release_sha256: good }
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.manifest.binary.sha256, good);
  const list = db.listAgentArtifacts().filter((a) => a.sha256 === good);
  assert.strictEqual(list.length, 1, '下载校验通过后应转存为 artifact');
});

test('分发包：tar.gz 能被系统 GNU tar 正确解包（header 字段必须是合法八进制）', async () => {
  if (!hasTar()) return; // 环境无 tar 时跳过（CI/开发机一般都有）
  const art = await uploadArtifact('linux-amd64', FAKE_BIN);
  const res = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: [],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'artifact', artifact_id: art.artifact_id }
  });
  assert.strictEqual(res.status, 200);
  const pkgRow = db.getAgentDistribution(res.body.pkg_id);
  const file = path.join(distribution.PKG_DIR, pkgRow.filename);
  // 清单必须能被 tar 列出（不报错、含全部文件）
  const listing = execFileSync('tar', ['tzf', file], { encoding: 'utf8' });
  for (const name of ['update.sh', 'diting-agent', 'diting-agent.sha256', 'manifest.json', 'README.txt']) {
    assert.ok(listing.split('\n').includes(name), `tar 清单应含 ${name}`);
  }
  // 脚本必须带可执行位（真机验证发现漏掉 0755 会直接「权限不够」）
  const verbose = execFileSync('tar', ['tvzf', file], { encoding: 'utf8' });
  const shLine = verbose.split('\n').find((l) => l.endsWith('update.sh')) || '';
  assert.ok(/-rwxr-xr-x/.test(shLine), `update.sh 应带可执行位 0755（实际：${shLine.trim()}）`);
  // 实际解包到临时目录并核对内容（这是抓到手写 tar header 八进制错误的那层校验）
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'diting-tar-'));
  execFileSync('tar', ['xzf', file, '-C', dir]);
  const extracted = fs.readFileSync(path.join(dir, 'diting-agent'));
  assert.ok(extracted.equals(FAKE_BIN), '解包出的二进制应与上传内容逐字节一致');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 2b. official 来源（复用签名中继的验签链路）-----------------------------

test('official 来源：验签通过才放行；sha256 与官方资产交叉校验', async () => {
  const relay = require('../src/agent-relay');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12); // SPKI 尾部 32B = raw pub
  relay._test.setVerifyKey(rawPub);
  relay._test.resetTagCache();
  // 从干净缓存开始（relay 只缓存验签通过的产物，命中缓存会跳过验签与重算）
  fs.rmSync(relay._test.cacheDir(), { recursive: true, force: true });

  // 构造合法 ELF 头（e_machine @18 = 0x3e x86-64）：relay 的架构校验是 fail closed 的，
  // 读不出机器类型一律拒发 ⇒ 测试必须给一个「像样」的二进制。
  const elf = Buffer.alloc(64);
  elf.write('\x7fELF', 0, 'latin1');
  elf[4] = 2; elf[5] = 1;                 // 64-bit / little-endian
  elf.writeUInt16LE(0x3e, 18);            // e_machine = EM_X86_64
  const bin = Buffer.concat([elf, Buffer.alloc(2048, 3)]);
  const shaHex = crypto.createHash('sha256').update(bin).digest('hex');
  // 官方资产：二进制 + .sha256 + .sig（ed25519 签名）
  const sig = crypto.sign(null, bin, privateKey);

  relay._test.setFetcher(async (url) => {
    if (url.includes('/releases/latest')) {
      // GitHub API：取最新 tag
      return { status: 200, body: Buffer.from(JSON.stringify({ tag_name: 'agent-go-v9.9.9' })), headers: {} };
    }
    if (url.endsWith('.sha256')) {
      return { status: 200, body: Buffer.from(`${shaHex}  diting-agent-linux-amd64\n`), headers: {} };
    }
    if (url.endsWith('.sig')) {
      return { status: 200, body: sig, headers: {} };
    }
    return { status: 200, body: bin, headers: {} };
  });

  const res = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: [],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'official' }
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.manifest.binary.sha256, shaHex, '包内 sha 应为官方资产 sha');
  assert.strictEqual(res.body.manifest.source.sha256_cross_checked, true, '应标记已交叉校验');

  // 篡改签名 ⇒ 必须拒绝（未验签的字节绝不能进包）
  // 注意：relay 只缓存**验签通过**的产物，命中缓存即视为可信 ⇒ 必须先清缓存才能重新走验签路径
  fs.rmSync(relay._test.cacheDir(), { recursive: true, force: true });
  relay._test.setFetcher(async (url) => {
    if (url.includes('/releases/latest')) {
      return { status: 200, body: Buffer.from(JSON.stringify({ tag_name: 'agent-go-v9.9.9' })), headers: {} };
    }
    if (url.endsWith('.sha256')) return { status: 200, body: Buffer.from(`${shaHex}  x\n`), headers: {} };
    if (url.endsWith('.sig')) return { status: 200, body: Buffer.alloc(64, 1), headers: {} };
    return { status: 200, body: bin, headers: {} };
  });
  const bad = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: [],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'official' }
  });
  assert.ok(bad.status >= 400, '签名无效时必须拒绝');
  assert.strictEqual(bad.body.error, 'signature_invalid');

  // sha256 资产与实际内容不符 ⇒ 必须拒绝
  fs.rmSync(relay._test.cacheDir(), { recursive: true, force: true });
  relay._test.setFetcher(async (url) => {
    if (url.includes('/releases/latest')) {
      return { status: 200, body: Buffer.from(JSON.stringify({ tag_name: 'agent-go-v9.9.9' })), headers: {} };
    }
    if (url.endsWith('.sha256')) return { status: 200, body: Buffer.from(`${'a'.repeat(64)}  x\n`), headers: {} };
    if (url.endsWith('.sig')) return { status: 200, body: sig, headers: {} };
    return { status: 200, body: bin, headers: {} };
  });
  const mismatch = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: [],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'official' }
  });
  assert.ok(mismatch.status >= 400, 'sha256 不一致时必须拒绝');

  relay._test.setFetcher(null);
  relay._test.resetTagCache();
});

test('official 来源：不支持的平台 → 明确报错', async () => {
  const res = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: [],
    target: { os: 'windows', arch: 'arm64' },
    source: { kind: 'official' }
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'official_platform_unsupported');
});

// ---- 3. 脚本红线 ------------------------------------------------------------

test('脚本红线：sha256 校验在替换之前 / 含回滚 / 不写 agent.env 与 run_scheduled.bat', () => {
  // 去掉注释行后再断言「脚本体」——注释里提到这些文件是为了说明「不会碰它们」。
  const codeOf = (s) => s.replace(/^\uFEFF/, '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  const sh = distribution.renderUpdateSh({ pkgId: 'pkg_test', platform: 'linux-amd64', generatedAt: '2026-10-25T00:00:00Z' });
  const idxVerify = sh.indexOf('sha256sum -c');
  const idxReplace = sh.indexOf('mv -f "$BIN.tmp" "$BIN"');
  assert.ok(idxVerify > 0 && idxReplace > 0, '脚本应同时含校验与替换');
  assert.ok(idxVerify < idxReplace, '校验必须发生在替换之前');
  assert.ok(sh.includes('diting-agent.bak-'), '应含备份命名');
  assert.ok(/date \+%Y%m%d-%H%M%S/.test(sh), '备份名应带时分秒（同日多次升级不互相覆盖）');
  assert.ok(sh.includes('回滚'), '应含回滚分支');
  const shCode = codeOf(sh);
  assert.ok(!/agent\.env[^\n]*>/.test(shCode), '脚本体绝不能写 agent.env');
  assert.ok(!/tee[^\n]*agent\.env/.test(shCode), '脚本体绝不能用 tee 写 agent.env');
  assert.ok(sh.includes('[ -f "$ENV_FILE" ]'), 'agent.env 只做存在性检查');
  // 真机验证教训：直接 cp 覆盖运行中的二进制会 "Text file busy"（ETXTBSY），
  // 回滚必须与升级路径一样走「写 tmp + 原子 mv」。
  assert.ok(!/cp -a "\$BAK" "\$BIN"/.test(shCode), '回滚不得用 cp 直接覆盖运行中的二进制');
  assert.ok(/install -m 755 "\$1" "\$BIN\.rollback\.tmp"/.test(shCode), '回滚应写临时文件再原子替换');
  assert.ok(/mv -f "\$BIN\.rollback\.tmp" "\$BIN"/.test(shCode), '回滚应用 mv 原子替换');

  const ps = distribution.renderUpdatePs1({ pkgId: 'pkg_test', platform: 'windows-amd64', generatedAt: '2026-10-25T00:00:00Z', agentId: 'agt_x' });
  // 真机验证教训：Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解析，
  // 中文注释被解成乱码 → 字符串终止符错乱 → ParserError。必须带 UTF-8 BOM。
  assert.ok(ps.charCodeAt(0) === 0xFEFF, 'update.ps1 必须以 UTF-8 BOM 开头');
  const idxHash = ps.indexOf('Get-FileHash');
  const idxCopy = ps.indexOf('Copy-Item -Path $NewExe');
  assert.ok(idxHash > 0 && idxCopy > 0);
  assert.ok(idxHash < idxCopy, '校验必须发生在替换之前');
  assert.ok(ps.includes('diting-agent.exe.bak-'), '应含备份命名');
  assert.ok(ps.includes('已回滚'), '应含回滚分支');
  const psCode = codeOf(ps);
  assert.ok(!psCode.includes('run_scheduled.bat'), '脚本体绝不能碰 run_scheduled.bat');
  assert.ok(!/Set-Content|Add-Content|Out-File/i.test(psCode), '脚本体不应改写任何文本文件');
  // Windows 不允许替换运行中的 exe ⇒ 替换前必须结束残留进程
  assert.ok(/Stop-Process -Force/.test(psCode), '替换前应结束残留进程（运行中的 exe 不可替换）');
  assert.ok(/yyyyMMdd-HHmmss/.test(ps), 'Windows 备份名也应带时分秒（同日多次升级不互相覆盖）');
  assert.ok(/OutputEncoding/.test(ps), 'ps1 应把控制台输出设为 UTF-8（远程会话里中文可读）');
  assert.ok(/Move-Item/.test(psCode), '应通过临时文件 + Move-Item 原子替换');
});

// ---- 4. 一次性下载 token ----------------------------------------------------

test('下载：一次性 token 可下载，重放被拒，无效签名被拒', async () => {
  const art = await uploadArtifact('linux-amd64', FAKE_BIN);
  const create = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: ['agt_1'],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'artifact', artifact_id: art.artifact_id }
  });
  assert.strictEqual(create.status, 200);
  const pkgId = create.body.pkg_id;
  const token = create.body.one_time_token;

  // 无 token → 403
  let res = await request(app).get(`/api/admin/agent-distribution/${pkgId}/download`);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'invalid_token');

  // 篡改签名 → 403
  res = await request(app).get(`/api/admin/agent-distribution/${pkgId}/download?t=${'0'.repeat(64)}`);
  assert.strictEqual(res.status, 403);

  // 正常下载 → 200，响应头带 attachment + nosniff
  res = await request(app).get(`/api/admin/agent-distribution/${pkgId}/download?t=${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'application/octet-stream');
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  assert.match(String(res.headers['content-disposition']), /attachment/);
  assert.ok(Number(res.headers['content-length']) > 0);

  // 重放 → 410（用后即焚）
  res = await request(app).get(`/api/admin/agent-distribution/${pkgId}/download?t=${token}`);
  assert.strictEqual(res.status, 410);
  assert.strictEqual(res.body.error, 'token_used');
});

test('下载：未知包 → 404；过期包 → 410', async () => {
  let res = await request(app).get('/api/admin/agent-distribution/pkg_not_exist/download?t=' + 'a'.repeat(64));
  assert.strictEqual(res.status, 404);

  // 构造一个已过期的包记录（直接改库中的 expires_at）
  const art = await uploadArtifact('linux-amd64', FAKE_BIN);
  const create = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: [],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'artifact', artifact_id: art.artifact_id },
    expires_in_minutes: 1
  });
  const pkgId = create.body.pkg_id;
  const token = create.body.one_time_token;
  db.db.prepare('UPDATE agent_distributions SET expires_at = ? WHERE pkg_id = ?').run(Date.now() - 1000, pkgId);
  res = await request(app).get(`/api/admin/agent-distribution/${pkgId}/download?t=${token}`);
  assert.strictEqual(res.status, 410);
  assert.strictEqual(res.body.error, 'expired');
});

// ---- 5. 鉴权 ----------------------------------------------------------------

test('鉴权：管理端点需 admin 凭据；下载端点只认 token（不需管理员）', async () => {
  let res = await request(app).get('/api/admin/agent-artifacts');
  assert.strictEqual(res.status, 401, '无凭据应 401');

  res = await request(app).post('/api/admin/agent-distribution').send({
    agent_ids: [], target: { os: 'linux', arch: 'amd64' }, source: { kind: 'artifact', artifact_id: 'art_x' }
  });
  assert.strictEqual(res.status, 401, '无凭据应 401');

  // 下载端点不需要管理员凭据（只认一次性 token）
  res = await request(app).get('/api/admin/agent-distribution/pkg_not_exist/download?t=' + 'a'.repeat(64));
  assert.strictEqual(res.status, 404, '下载端点不应因缺管理员凭据而 401');
});

// ---- 6. 审计 ----------------------------------------------------------------

test('审计：artifact 上传/删除与分发包生成/下载都留痕', async () => {
  const art = await uploadArtifact('linux-amd64', FAKE_BIN);
  const create = await request(app).post('/api/admin/agent-distribution').set(ADMIN).send({
    agent_ids: ['agt_1'],
    target: { os: 'linux', arch: 'amd64' },
    source: { kind: 'artifact', artifact_id: art.artifact_id }
  });
  await request(app).get(`/api/admin/agent-distribution/${create.body.pkg_id}/download?t=${create.body.one_time_token}`);
  await request(app).delete(`/api/admin/agent-artifacts/${art.artifact_id}`).set(ADMIN);

  const logs = db.getAuditLogs({ limit: 50 });
  assert.ok(logs.some((l) => l.action === 'agent_artifact_upload'), 'artifact 上传应写审计');
  assert.ok(logs.some((l) => l.action === 'agent_distribution_create'), '生成分发包应写审计');
  assert.ok(logs.some((l) => l.action === 'agent_distribution_download'), '下载应写审计');
  assert.ok(logs.some((l) => l.action === 'agent_artifact_delete'), 'artifact 删除应写审计');
});
