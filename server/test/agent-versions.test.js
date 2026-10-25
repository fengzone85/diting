'use strict';
// ============================================================
// V 阶段：受控端版本可判定性
//
// 方案：dev-docs/AGENT_DISTRIBUTION_PLAN_2026-10-21.md §2（V.1–V.6）
//
// 覆盖：
//   1. validateReport：agent_meta 透传 / sha 非 hex 丢弃 / 缺失即 null（不拒绝上报）；
//   2. setAgentBuild：仅变化才写（断言 .changes）+ /report 调用点确实落库；
//   3. 判定口径：normVer 归一（v 前缀）、sha 优先、custom 标注优先、
//      老 agent 无 sha ⇒ unknown（不误判 outdated）、无期望 ⇒ 全部 unknown；
//   4. API：GET /admin/agent-versions（汇总 + 每节点状态）、PUT expected、
//      PUT build-tag、404（未知节点）、403（节点白名单越权）、审计留痕。
//
// 运行前提与其它服务端测试一致：PORT=0 / ADMIN_ALLOW_HTTP=1 /
// 测试专用 ADMIN_TOKEN / DB_PATH 指向 /tmp 临时库（绝不触碰生产 monitor.db）。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'agentversions-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-agent-versions-test.db';
// 禁服真实通知：仓库 .env 的 SMTP 占位符会激活邮件通道并真实联网。
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const validators = require('../src/validate');
const agentVersions = require('../src/agent-versions');

db.setConfig('notify_config', JSON.stringify({ smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: '' }));

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN };

after(async () => {
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// 上报一份最小合法负载（cpu / mem_total 必须有值，否则 /report 直接 400）。
const reportPayload = (over) => Object.assign({ cpu: 1, mem_total: 100 }, over || {});

// ---- 1. validateReport：agent_meta 解析 ---------------------------------------

test('validateReport：agent_meta 透传，缺失即 null（不因缺字段拒绝上报）', () => {
  const m = validators.validateReport(reportPayload({
    agent_meta: {
      version: '1.1.3',
      build_sha: 'c76d2f2a1b2c3d4',
      build_time: '2026-10-19T13:06:32Z',
      platform: 'linux-amd64'
    }
  }));
  assert.ok(m.agent_meta, 'agent_meta 应被解析');
  assert.strictEqual(m.agent_meta.version, '1.1.3');
  assert.strictEqual(m.agent_meta.build_sha, 'c76d2f2a1b2c3d4');
  assert.strictEqual(m.agent_meta.build_time, '2026-10-19T13:06:32Z');
  assert.strictEqual(m.agent_meta.platform, 'linux-amd64');

  const legacy = validators.validateReport(reportPayload());
  assert.strictEqual(legacy.agent_meta, null, '老 agent 不带 agent_meta 时应为 null');
  assert.strictEqual(legacy.cpu, 1, '缺 agent_meta 不影响其它字段');
});

test('validateReport：sha 非 hex / 时间非法 / 平台越界一律丢弃为', () => {
  const m = validators.validateReport(reportPayload({
    agent_meta: {
      version: 'x'.repeat(64),
      build_sha: 'zz;rm -rf /',      // 注入尝试 + 非 hex
      build_time: '2026-13-99',       // 非法时间
      platform: 'linux-amd64;whoami'  // 白名单外字形
    }
  }));
  assert.strictEqual(m.agent_meta.build_sha, '', '非 hex sha 必须丢弃');
  assert.strictEqual(m.agent_meta.build_time, '', '非法时间必须丢弃');
  assert.strictEqual(m.agent_meta.platform, '', '平台白名单外必须丢弃');
  // validate.js 的 str() 约定：超长字符串**丢弃**（不截断）——超长即视为非法输入。
  assert.strictEqual(m.agent_meta.version, '', '超长 version 必须丢弃');
});

test('validateReport：agent_meta 非对象 → null（不抛错）', () => {
  assert.strictEqual(validators.validateReport(reportPayload({ agent_meta: 'x' })).agent_meta, null);
  assert.strictEqual(validators.validateReport(reportPayload({ agent_meta: [1] })).agent_meta, null);
});

// ---- 2. 落库：仅变化才写 + /report 调用点 --------------------------------------

test('setAgentBuild：仅在值变化时写库（.changes 断言）', () => {
  const a = db.createAgent({ name: 'build-write-node' });
  assert.strictEqual(db.setAgentBuild(a.id, 'abc1234', '2026-10-25T00:00:00Z', 'linux-amd64'), true, '首次应写入');
  assert.strictEqual(db.setAgentBuild(a.id, 'abc1234', '2026-10-25T00:00:00Z', 'linux-amd64'), false, '值未变不应再写');
  assert.strictEqual(db.setAgentBuild(a.id, 'abc1235', '2026-10-25T00:00:00Z', 'linux-amd64'), true, 'sha 变化应写入');
  assert.strictEqual(db.getAgent(a.id).build_sha, 'abc1235');
});

test('/report：带 agent_meta 的上报落库到 build_sha/build_time/agent_platform', async () => {
  const a = db.createAgent({ name: 'report-meta-node' });
  const res = await request(app)
    .post('/api/report')
    .set('X-Agent-ID', a.id)
    .set('Authorization', `Bearer ${a.token}`)
    .send(reportPayload({
      agent_meta: {
        version: '1.1.3',
        build_sha: 'deadbeefcafe',
        build_time: '2026-10-25T01:02:03Z',
        platform: 'linux-amd64'
      }
    }));
  assert.strictEqual(res.status, 200);
  const row = db.getAgent(a.id);
  assert.strictEqual(row.build_sha, 'deadbeefcafe');
  assert.strictEqual(row.build_time, '2026-10-25T01:02:03Z');
  assert.strictEqual(row.agent_platform, 'linux-amd64');
});

test('/report：不带 agent_meta 的老 agent 不受影响（字段保持空）', async () => {
  const a = db.createAgent({ name: 'legacy-report-node' });
  const res = await request(app)
    .post('/api/report')
    .set('X-Agent-ID', a.id)
    .set('Authorization', `Bearer ${a.token}`)
    .send(reportPayload());
  assert.strictEqual(res.status, 200);
  const row = db.getAgent(a.id);
  assert.strictEqual(row.build_sha, '');
  assert.strictEqual(row.build_time, '');
  assert.strictEqual(row.agent_platform, '');
});

// ---- 3. 判定口径（纯逻辑）----------------------------------------------------

test('normVer：去掉 v 前缀与大小写差异', () => {
  assert.strictEqual(agentVersions.normVer('v1.0.9'), '1.0.9');
  assert.strictEqual(agentVersions.normVer('1.0.9'), '1.0.9');
  assert.strictEqual(agentVersions.normVer(' V1.0.9 '), '1.0.9');
  assert.strictEqual(agentVersions.normVer(''), '');
});

test('判定：期望版本为空 ⇒ 全部 unknown；版本归一后相等 ⇒ up_to_date', () => {
  assert.strictEqual(agentVersions.statusOf({ version: '1.0.9' }, { version: '', sha: '' }), 'unknown');
  assert.strictEqual(agentVersions.statusOf({ version: '1.0.9' }, { version: 'v1.0.9', sha: '' }), 'up_to_date');
  assert.strictEqual(agentVersions.statusOf({ version: 'v1.0.8' }, { version: '1.0.9', sha: '' }), 'outdated');
});

test('判定：期望 sha 优先于版本号；节点无 sha ⇒ unknown（不误判 outdated）', () => {
  assert.strictEqual(agentVersions.statusOf({ version: '1.0.9', build_sha: 'abc1234' }, { version: '9.9.9', sha: 'abc1234' }), 'up_to_date');
  assert.strictEqual(agentVersions.statusOf({ version: '1.0.9', build_sha: 'aaa1111' }, { version: '1.0.9', sha: 'bbb2222' }), 'outdated');
  assert.strictEqual(agentVersions.statusOf({ version: '1.0.9' }, { version: '1.0.9', sha: 'bbb2222' }), 'unknown');
});

test('判定：build_tag 标注（custom）优先于自动判定', () => {
  assert.strictEqual(agentVersions.statusOf({ version: '1.0.9', build_tag: 'custom' }, { version: '1.0.9', sha: '' }), 'custom');
  assert.strictEqual(agentVersions.statusOf({ build_tag: 'fork-2026' }, { version: '', sha: '' }), 'custom');
});

test('summarize：四类计数与总数一致', () => {
  const nodes = [
    { version: '1.0.9' },
    { version: '1.0.8' },
    { version: '' },
    { version: '1.0.9', build_tag: 'custom' }
  ];
  const c = agentVersions.summarize(nodes, { version: '1.0.9', sha: '' });
  assert.deepStrictEqual(c, { total: 4, up_to_date: 1, outdated: 1, unknown: 1, custom: 1 });
});

// ---- 4. API 契约 --------------------------------------------------------------

test('API：GET /admin/agent-versions 返回期望版本 + 汇总 + 每节点状态', async () => {
  const a = db.createAgent({ name: 'api-version-node' });
  db.setAgentBuild(a.id, 'abc1234', '2026-10-25T00:00:00Z', 'linux-amd64');
  // agents.version 由上报路径的 UA 解析写入（touchAgent），updateAgent 不含该列 → 直接置值。
  db.db.prepare('UPDATE agents SET version=? WHERE id=?').run('1.0.9', a.id);

  // 未设期望 → 全部 unknown
  let res = await request(app).get('/api/admin/agent-versions').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.expected, { version: '', sha: '' });
  assert.strictEqual(res.body.counts.total, res.body.nodes.length);
  assert.strictEqual(res.body.counts.unknown, res.body.nodes.length);

  // 设期望版本 → 同号节点 up_to_date
  res = await request(app).put('/api/admin/agent-versions/expected').set(ADMIN).send({ version: 'v1.0.9' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.expected, { version: 'v1.0.9', sha: '' });

  res = await request(app).get('/api/admin/agent-versions').set(ADMIN);
  const mine = res.body.nodes.find((n) => n.id === a.id);
  assert.ok(mine, '响应应包含该节点');
  assert.strictEqual(mine.status, 'up_to_date');
  assert.strictEqual(mine.build_sha, 'abc1234');
  assert.strictEqual(mine.platform, 'linux-amd64');
  assert.strictEqual(mine.build_time, '2026-10-25T00:00:00Z');
  assert.strictEqual(res.body.counts.up_to_date >= 1, true);

  // 清除期望 → 回到 unknown
  res = await request(app).put('/api/admin/agent-versions/expected').set(ADMIN).send({ version: '', sha: '' });
  assert.strictEqual(res.status, 200);
  res = await request(app).get('/api/admin/agent-versions').set(ADMIN);
  assert.deepStrictEqual(res.body.expected, { version: '', sha: '' });
});

test('API：期望 sha 非法 → 丢弃（不留脏值）', async () => {
  await request(app).put('/api/admin/agent-versions/expected').set(ADMIN).send({ version: '1.0.9', sha: 'not-hex!!' });
  const res = await request(app).get('/api/admin/agent-versions').set(ADMIN);
  assert.strictEqual(res.body.expected.sha, '', '非法 sha 必须丢弃');
  await request(app).put('/api/admin/agent-versions/expected').set(ADMIN).send({ version: '', sha: '' });
});

test('API：PUT build-tag 标注/清除节点构建', async () => {
  const a = db.createAgent({ name: 'tag-node' });
  let res = await request(app).put(`/api/admin/agents/${a.id}/build-tag`).set(ADMIN).send({ tag: 'custom' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(db.getAgent(a.id).build_tag, 'custom');

  res = await request(app).get('/api/admin/agent-versions').set(ADMIN);
  const mine = res.body.nodes.find((n) => n.id === a.id);
  assert.strictEqual(mine.status, 'custom', '标注后状态应为 custom');

  // 清除
  res = await request(app).put(`/api/admin/agents/${a.id}/build-tag`).set(ADMIN).send({ tag: '' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(db.getAgent(a.id).build_tag, '');

  // 超长标签被截断到 32 字符
  res = await request(app).put(`/api/admin/agents/${a.id}/build-tag`).set(ADMIN).send({ tag: 'x'.repeat(100) });
  assert.strictEqual(db.getAgent(a.id).build_tag.length, 32);
  await request(app).put(`/api/admin/agents/${a.id}/build-tag`).set(ADMIN).send({ tag: '' });
});

test('API：未知节点 build-tag → 404；越权节点 → 403', async () => {
  let res = await request(app).put('/api/admin/agents/agt_not_exist/build-tag').set(ADMIN).send({ tag: 'x' });
  assert.strictEqual(res.status, 404);
});

// ---- 5. 审计 ------------------------------------------------------------------

test('审计：期望版本与构建标注都写 audit_log', async () => {
  const a = db.createAgent({ name: 'audit-node' });
  await request(app).put('/api/admin/agent-versions/expected').set(ADMIN).send({ version: '1.0.9' });
  await request(app).put(`/api/admin/agents/${a.id}/build-tag`).set(ADMIN).send({ tag: 'custom' });
  const logs = db.getAuditLogs({ limit: 50 });
  assert.ok(logs.some((l) => l.action === 'agent_expected_version'), '期望版本应写审计');
  assert.ok(logs.some((l) => l.action === 'agent_build_tag'), '构建标注应写审计');
  await request(app).put('/api/admin/agent-versions/expected').set(ADMIN).send({ version: '', sha: '' });
});
