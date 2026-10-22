'use strict';
// ============================================================
// 密钥入 DB（P2/D5+D7）：
//   D7  ADMIN_TOKEN 不再经 compose 注入；存量升级由 diting.sh 的
//       migrate_env_admin_token 在停容器前把 .env 明文转哈希入库；
//       compose 文件不得再出现 ADMIN_TOKEN= 行。
//   D5  SETUP_TOKEN 以库为权威：DB 有值用库；库空且 env 有值 → 一次性搬库；
//       管理面显式清除后，env 残留不得回灌；管理端可生成/设置/清除，明文只回显一次。
//   （SMTP_PASS / AI_API_KEY 早已存库，env 只是默认种子，本文件顺带回归不退化。）
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.DB_PATH = '/tmp/diting-secrets-db-test.db';
process.env.ADMIN_TOKEN = 'secrets-admin-token-0123456789abcdef';
process.env.SETUP_TOKEN = 'env-setup-token-7Kq2Xz9Rp4Wm';
process.env.AI_KEY_FROM_ENV = '0';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const db = require('../src/db');
const { app, server } = require('../server');
const alerts = require('../src/alerts');

const ADMIN = process.env.ADMIN_TOKEN;
const PROTO = { 'X-Forwarded-Proto': 'https' };
const XFF = { ...PROTO, 'X-Forwarded-For': '203.0.113.51' };
const admin = { 'X-Admin-Token': ADMIN, ...PROTO };
// 清空初始态，让每个用例自己摆场景（migrate 只在库空时发生）
beforeEach(() => {
  db.clearSetupToken();
  db.unmarkSetupTokenCleared();
});

after(async () => {
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// ---- D7：compose 不再注入 ADMIN_TOKEN ----------------------------------------

test('D7：docker-compose.yml 不得注入 ADMIN_TOKEN，且不能删掉 SESSION_SECRET', () => {
  const yml = fs.readFileSync(require('path').join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.ok(!/^\s*-\s*ADMIN_TOKEN=/m.test(yml), 'compose 不应再注入 ADMIN_TOKEN（docker inspect 可见即泄露）');
  assert.match(yml, /SESSION_SECRET=\$\{SESSION_SECRET:-}/, 'SESSION_SECRET 仍须保留（缺失会导致重启后会话全失效）');
});

test('D7：安装器在停容器前迁移 env 明文 → 库哈希（migrate_env_admin_token）', () => {
  const sh = fs.readFileSync(require('path').join(__dirname, '..', '..', 'diting.sh'), 'utf8');
  // 函数体必须在
  assert.match(sh, /^migrate_env_admin_token\(\) \{/m, '安装器应提供 migrate_env_admin_token');
  // 明文不得作为命令行参数传给 node（哈希在 bash 侧算）
  assert.match(sh, /printf '%s' "\$admin" \| sha256sum/, '哈希应在 bash 侧计算');
  // 两个升级路径都要调用，且必须早于 compose down
  for (const fn of ['install_server', 'update_server']) {
    const start = sh.indexOf(`\n${fn}() {`);
    assert.ok(start !== -1, `${fn} 应存在`);
    const end = sh.indexOf('\n}', start);
    const body = sh.slice(start, end);
    const iMig = body.indexOf('migrate_env_admin_token');
    const iDown = body.indexOf('docker compose down');
    assert.ok(iMig !== -1, `${fn} 应调用 migrate_env_admin_token`);
    assert.ok(iDown === -1 || iMig < iDown, `${fn} 中迁移必须先于 compose down`);
  }
});

// ---- D5：SETUP_TOKEN 以库为权威 ----------------------------------------------

test('D5：库空且 env 有值 → 首次使用时搬入库（之后以库为准）', async () => {
  assert.equal(db.getSetupToken(), '');
  const res = await request(app).get('/api/setup-token').set(admin);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { configured: true, source: 'env-migrated', weak: false });
  assert.equal(db.getSetupToken(), process.env.SETUP_TOKEN, 'env 明文应已搬库');
  // 运行期改 env 不再影响（库已权威）
  process.env.SETUP_TOKEN = 'other-token-7Kq2Xz9Rp4Wm';
  const after = await request(app).get('/api/setup-token').set(admin);
  assert.strictEqual(after.body.source, 'db');
  process.env.SETUP_TOKEN = 'env-setup-token-7Kq2Xz9Rp4Wm';
});

test('D5：注册端点用库中的令牌（env 改动不生效）', async () => {
  db.setSetupToken('lib-token-7Kq2Xz9Rp4Wm');
  process.env.SETUP_TOKEN = 'env-token-0123456789abcdef';
  try {
    const ok = await request(app).post('/api/setup/register').set(XFF)
      .send({ name: 'from-library', setup_token: 'lib-token-7Kq2Xz9Rp4Wm' });
    assert.strictEqual(ok.status, 200, '库令牌应可通过注册');
    const bad = await request(app).post('/api/setup/register').set(XFF)
      .send({ name: 'from-env', setup_token: 'env-token-0123456789abcdef' });
    assert.strictEqual(bad.status, 401, 'env 值应被忽略');
  } finally {
    process.env.SETUP_TOKEN = 'env-setup-token-7Kq2Xz9Rp4Wm';
  }
});

test('D5：显式清除后 env 残留不得回灌', async () => {
  db.setSetupToken('lib-token-7Kq2Xz9Rp4Wm');
  const res = await request(app).post('/api/setup-token').set(admin).send({ action: 'clear' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.configured, false);
  assert.equal(db.getSetupToken(), '');
  // env 仍有值，但已被墓碑标记压制
  const status = await request(app).get('/api/setup-token').set(admin);
  assert.strictEqual(status.body.configured, false);
  assert.strictEqual(status.body.source, 'cleared');
  const reg = await request(app).post('/api/setup/register').set(XFF)
    .send({ name: 'after-clear', setup_token: process.env.SETUP_TOKEN });
  assert.strictEqual(reg.status, 403, '清除后一键注册应停用');
  assert.equal(db.getSetupToken(), '', '墓碑必须阻止 env 回灌');
});

test('D5：生成令牌 → 明文只回显一次，库中可校验，弱令牌被拒', async () => {
  const gen = await request(app).post('/api/setup-token').set(admin).send({ action: 'generate' });
  assert.strictEqual(gen.status, 200);
  assert.ok(/^[0-9a-f]{32}$/.test(gen.body.token), '生成结果应为 32 位十六进制');
  assert.equal(db.getSetupToken(), gen.body.token);
  const status = await request(app).get('/api/setup-token').set(admin);
  assert.ok(!('token' in status.body), 'GET 不得回显明文');
  assert.strictEqual(status.body.configured, true);

  for (const weak of ['1234567890123456', 'aaaaaaaaaaaaaaaa', 'abcdef1234567890']) {
    const r = await request(app).post('/api/setup-token').set(admin).send({ action: 'set', token: weak });
    assert.strictEqual(r.status, 400, `弱令牌 ${weak} 应被拒`);
  }
  const bad = await request(app).post('/api/setup-token').set(admin).send({ action: 'set', token: 'short' });
  assert.strictEqual(bad.status, 400);
  const nope = await request(app).post('/api/setup-token').set(admin).send({ action: 'whatever' });
  assert.strictEqual(nope.status, 400);
  // 设置合法值后重新生效
  const set = await request(app).post('/api/setup-token').set(admin).send({ action: 'set', token: 'good-token-7Kq2Xz9Rp4Wm' });
  assert.strictEqual(set.status, 200);
  assert.equal(set.body.token, 'good-token-7Kq2Xz9Rp4Wm');
});

test('D5：管理面接口需要管理员权限', async () => {
  const r = await request(app).get('/api/setup-token').set(PROTO);
  assert.strictEqual(r.status, 401);
});

// ---- 回归：SMTP 密码 / AI Key 仍在库中 ---------------------------------------

test('回归：SMTP 密码入 notify 配置且读取时脱敏；AI Key 可写入库', async () => {
  // SMTP 密码：DB 存取 + /api/settings 不回显（密钥已入 DB 的历史事实不退化）
  db.setNotifyConfig({ smtp_host: 'smtp.example.com', smtp_port: 465, smtp_user: 'u@example.com', smtp_pass: 'sup3r-secret', alert_to: 'ops@example.com' });
  assert.equal(db.getNotifyConfig().smtp_pass, 'sup3r-secret', '密码应已存库');
  const got = await request(app).get('/api/settings').set(admin);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.body.notify.smtp_pass, '', '读取时不得回显密码');
  assert.strictEqual(got.body.notify.smtp_user, 'u@example.com', '非密字段仍应回显');

  const ai = await request(app).put('/api/ai/config').set(admin).send({ config: { model: 'gpt-4o-mini', api_key: 'sk-test-0001' } });
  assert.strictEqual(ai.status, 200);
  assert.equal(db.getAiConfig().api_key, 'sk-test-0001');
});
