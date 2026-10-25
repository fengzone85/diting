'use strict';
// ============================================================
// F7 在线时段统计回归
//
// 锚定行为（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md F7）：
//   1. 状态机：online → 开 session（起点回填一个上报间隔）；offline → 关闭到 last_seen；
//      恢复后新 session 起点不早于上一段 ended_at（不重叠双计）。
//   2. 启动清理：孤儿 session 删除；stale open session 关闭到 last_seen（reason=stale）。
//   3. daily 聚合：按主机本地日切分，跨天 session 两天各计一半；今天分母是已过去的时间。
//   4. deleteAgent 同事务清掉 online_sessions；prune 只清已结束且超期的。
//   5. API：管理端/公开端同形返回；/api/public/agents 附带 uptime_30d。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'online-sessions-admin-token-0123456789';
process.env.DB_PATH = '/tmp/diting-online-sessions-test.db';
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

db.setConfig('notify_config', JSON.stringify({
  smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: ''
}));

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN };
const CFG = { offlineSec: 60, cooldown: 1800, cpuAlert: 90, memAlert: 90, diskAlert: 90, tempAlert: 90, muted: false };

const sessionsOf = (id) => db.db.prepare('SELECT * FROM online_sessions WHERE agent_id=? ORDER BY started_at ASC').all(id);
const localMidnight = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

after(async () => {
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// ---- 1. 状态机 -------------------------------------------------------------

test('F7 状态机：上线开段（回填一个间隔）→ 离线关闭到 last_seen → 恢复不重叠', async () => {
  const id = db.createAgent({ name: 'f7-state' }).id;
  db.touchAgent(id, 'linux', 'h', 'v1');

  const t0 = Date.now() - 3600 * 1000;
  await alerts.checkAgent({ id, name: 'f7-state', last_seen: t0 }, t0, CFG);
  let open = db.getOpenOnlineSession(id);
  assert.ok(open, '在线应开一条 open session');
  assert.ok(open.started_at <= t0, '起点不能晚于首次观测到在线的时刻');
  assert.ok(t0 - open.started_at >= 10 * 1000, '起点应回填一个上报间隔（默认 20s）');

  // 10 分钟后仍无新上报 → 判定离线，关闭点应是 last_seen（真实失联时刻）
  const t1 = t0 + 600 * 1000;
  await alerts.checkAgent({ id, name: 'f7-state', last_seen: t0 }, t1, CFG);
  assert.strictEqual(db.getOpenOnlineSession(id), undefined);
  let rows = sessionsOf(id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].end_reason, 'offline');
  assert.strictEqual(rows[0].ended_at, t0);

  // 恢复：新 session 起点 = last_seen - 间隔，且不得早于上一段 ended_at
  const t2 = t1 + 600 * 1000;
  await alerts.checkAgent({ id, name: 'f7-state', last_seen: t2 }, t2, CFG);
  rows = sessionsOf(id);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows[1].started_at >= rows[0].ended_at, '两段 session 不允许重叠');
  assert.ok(rows[1].ended_at == null);
});

test('F7 状态机：pending 未确认节点不进入监控，也不会产生 session', async () => {
  const id = db.createAgent({ name: 'f7-pending' }).id;
  db.db.prepare('UPDATE agents SET pending=1 WHERE id=?').run(id);
  assert.ok(!db.getMonitoredAgents().some((a) => a.id === id));
  assert.strictEqual(sessionsOf(id).length, 0);
});

// ---- 2. 启动清理 -----------------------------------------------------------

test('F7 清理：孤儿 session 删除；stale open 关闭到 last_seen 且 reason=stale', () => {
  const now = Date.now();
  const staleId = db.createAgent({ name: 'f7-stale' }).id;
  const oldSeen = now - 3 * 86400000;
  db.db.prepare('UPDATE agents SET last_seen=? WHERE id=?').run(oldSeen, staleId);
  db.db.prepare('INSERT INTO online_sessions(agent_id,started_at) VALUES(?,?)').run(staleId, now - 4 * 86400000);

  db.db.prepare('INSERT INTO online_sessions(agent_id,started_at,ended_at,end_reason) VALUES(?,?,?,?)')
    .run('agt_ghost_orphan', now - 2 * 86400000, now - 2 * 86400000 + 60000, 'offline');

  const r = db.cleanupOnlineSessions(now);
  assert.ok(r.removed >= 1, '孤儿 session 应被删除');
  assert.strictEqual(r.closed, 1, 'stale open session 应被关闭');

  const rows = sessionsOf(staleId);
  assert.strictEqual(rows[0].ended_at, oldSeen, '关闭点是 last_seen');
  assert.strictEqual(rows[0].end_reason, 'stale');
});

// ---- 3. daily 聚合 ---------------------------------------------------------

test('F7 聚合：跨天 session 按本地日切分；今天分母为已过去时间', () => {
  const id = db.createAgent({ name: 'f7-agg' }).id;
  // 用**固定参照时刻**而不是真实 now：
  // 原写法依赖真实时钟 —— 本地时间落在 00:00–01:00 窗口时，「今天 01:00」的 session
  // 尚未结束，今天那段会被截断成「已过去的秒数」，断言 3600 必然失败（时间相关 flake）。
  // 固定观察时刻后，本用例与真实时钟解耦，任何时间跑结果一致。
  const REF_OFFSET_MS = 19 * 3600 * 1000 + 45 * 60 * 1000; // 今天 19:45（与历史跑的时段一致）
  const today0 = localMidnight(Date.now());
  const now = today0 + REF_OFFSET_MS;
  const y0 = localMidnight(today0 - 86400000);
  // 昨天 23:00 → 今天 01:00，应各记 3600s
  const s = y0 + 23 * 3600 * 1000;
  const e = today0 + 1 * 3600 * 1000;
  db.db.prepare('INSERT INTO online_sessions(agent_id,started_at,ended_at,end_reason) VALUES(?,?,?,?)')
    .run(id, s, e, 'offline');

  const h = db.onlineHistory(id, 7, now);
  assert.strictEqual(h.daily.length, 7, '应返回完整 7 天（无数据的补 0）');
  const y = h.daily.find((d) => d.date === dayKey(y0));
  const t = h.daily.find((d) => d.date === dayKey(today0));
  assert.ok(y && t);
  // 本地日切分：昨天 23:00-24:00 = 3600s；今天 00:00-01:00 = 3600s
  assert.strictEqual(y.up_sec, 3600);
  assert.strictEqual(t.up_sec, 3600);
  // 昨天只在线 1 小时 → 3600/86400 ≈ 4.2%，不是 100%
  assert.strictEqual(y.pct, 4.2);
  assert.ok(t.pct != null && t.pct > 0 && t.pct < 100, '今天分母是已过去的时间');

  // 覆盖率分母从窗口内首段 session 起算：2 小时在线 / 约 22.5 小时覆盖 ≈ 8.9%，
  // 而不是 2 小时 / 7 天（那样会低到 1.2%，属于把「上线前」算成停机）
  assert.ok(h.uptime_pct != null && h.uptime_pct > 8 && h.uptime_pct < 12, `uptime_pct=${h.uptime_pct}`);
  // 停机缺口：session 之外到 now 应记为一条进行中的 outage
  assert.ok(h.outages.some((o) => o.ended_at == null), '当前不在线的尾部应列为进行中缺口');
});

// ---- 4. 删除 / 保留 --------------------------------------------------------

test('F7 删除：软删保留 online_sessions，purge 时清掉（F11 语义）', () => {
  const id = db.createAgent({ name: 'f7-del' }).id;
  db.db.prepare('INSERT INTO online_sessions(agent_id,started_at) VALUES(?,?)').run(id, Date.now());
  assert.strictEqual(sessionsOf(id).length, 1);
  // F11：删除是软删（一条 UPDATE），在线时段保留 —— 7 天缓冲内恢复时在线率可延续。
  db.deleteAgent(id);
  assert.strictEqual(db.getAgent(id), undefined, '软删后 getAgent 应读不到该节点');
  assert.strictEqual(sessionsOf(id).length, 1, '软删期间 online_sessions 应保留');
  // 缓冲期到期 → purge 物理清理时一并清掉 online_sessions（该表无 FK）
  db.purgeDeletedAgents(Date.now() + 8 * 86400000);
  assert.strictEqual(sessionsOf(id).length, 0, 'purge 后 online_sessions 必须被清掉');
});

test('F7 保留：prune 只清已结束且超期的 session，进行中的保留', () => {
  const id = db.createAgent({ name: 'f7-prune' }).id;
  const now = Date.now();
  db.db.prepare('INSERT INTO online_sessions(agent_id,started_at,ended_at,end_reason) VALUES(?,?,?,?)')
    .run(id, now - 40 * 86400000, now - 39 * 86400000, 'offline'); // 超 30 天
  db.db.prepare('INSERT INTO online_sessions(agent_id,started_at) VALUES(?,?)')
    .run(id, now - 40 * 86400000); // 进行中（异常长时间），不应被删
  db.prune(30);
  const rows = sessionsOf(id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ended_at, null);
});

// ---- 5. API ---------------------------------------------------------------

test('F7 API：管理端与公开端同形返回；公开列表附 uptime_30d', async () => {
  const id = db.createAgent({ name: 'f7-api' }).id;
  const now = Date.now();
  db.db.prepare('INSERT INTO online_sessions(agent_id,started_at,ended_at,end_reason) VALUES(?,?,?,?)')
    .run(id, now - 3600 * 1000, now - 1800 * 1000, 'offline');
  db.touchAgent(id, 'linux', 'h', 'v1');

  const admin = await request(app).get(`/api/agents/${id}/online-history?days=7`).set(ADMIN);
  assert.strictEqual(admin.status, 200);
  assert.strictEqual(admin.body.daily.length, 7);
  assert.ok(Array.isArray(admin.body.outages));
  assert.ok('uptime_pct' in admin.body);

  const pub = await request(app).get(`/api/public/agents/${id}/online-history?days=7`);
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(pub.body.daily.length, 7);
  assert.strictEqual(pub.body.uptime_pct, admin.body.uptime_pct);

  const list = await request(app).get('/api/public/agents');
  assert.strictEqual(list.status, 200);
  const me = list.body.find((a) => a.id === id);
  assert.ok(me, '公开列表应包含该节点');
  assert.strictEqual(typeof me.uptime_30d, 'number');
  assert.ok(me.uptime_30d >= 0 && me.uptime_30d <= 100);
});
