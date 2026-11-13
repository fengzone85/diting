'use strict';
// ============================================================
// REL-07 / REL-08：告警恢复方向「发成功再清」回归断言（Batch C）
//
// 锚定行为：
//   1. 上线通知投递失败 → 保留离线起点，下一轮 check 重试；成功后不再重发；
//   2. 宽限期内恢复 → 不发，且持久化回退不会在时长增长后补发；
//   3. 指标恢复投递失败 → 保留 alert_state 重试；成功后清状态、不重发；
//   4. 进程重启（内存起点丢失）→ 回退上一已关闭在线时段 ended_at 发上线通知；
//   5. 重启时节点一直在线（关闭段距今很近）→ 宽限期抑制，不误发；
//   6. 新离线段重新置位：再次离线→恢复可再发。
//
// 投递桩：直接替换 notify.sendEvent（alerts.sendAlert 在调用时动态取属性）。
// 运行前提同 alert-rules.test.js：PORT=0 / 临时库 / 禁真实通知。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'alertrecovery-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-alert-recovery-test.db';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
delete process.env.ALERT_SUSTAIN_SAMPLES;
delete process.env.ONLINE_NOTIFY_GRACE_SEC; // 默认 180s 宽限期

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const notify = require('../src/notify');

db.setConfig('notify_config', JSON.stringify({ smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: '' }));

const NOW = Date.now();
const realSendEvent = notify.sendEvent;
let calls = [];
let deliverOk = false;
notify.sendEvent = async (event, ctx) => {
  calls.push({ event, agentId: ctx && ctx.agentId, text: ctx && ctx.text });
  return deliverOk;
};
const resetCalls = () => { calls = []; };
const onlineCalls = (id) => calls.filter((c) => c.event === 'online' && c.agentId === id);

after(async () => {
  notify.sendEvent = realSendEvent;
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

const put = (id, ts, over) => db.insertMetric(id, Object.assign({ ts }, over || {}));

// ---- 1. 上线通知：失败重试 / 成功不重发 -------------------------------------

test('REL-07 上线通知：投递失败保留起点逐轮重试，成功后不再重发', async () => {
  const a = db.createAgent({ name: 'rel07-online-retry' });
  // T-300s 判离线 ⇒ OFFLINE_SINCE = T-300s（离线 1h，明确超阈值）
  const t0 = NOW - 300000;
  deliverOk = true; // 离线触发方向先成功，避免其重试干扰计数
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: t0 - 3600 * 1000 }, t0);
  resetCalls();

  // 恢复但投递失败 → 起点保留
  deliverOk = false;
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW }, NOW);
  assert.strictEqual(onlineCalls(a.id).length, 1, '首轮恢复应尝试投递');
  // 后续两轮仍失败 → 持续重试（旧实现此处为 0：一次性丢失）
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW + 10000 }, NOW + 10000);
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW + 20000 }, NOW + 20000);
  assert.strictEqual(onlineCalls(a.id).length, 3, '失败后每轮重试');

  // 投递成功 → 标记已处理，之后不再发
  deliverOk = true;
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW + 30000 }, NOW + 30000);
  assert.strictEqual(onlineCalls(a.id).length, 4, '成功轮投递一次');
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW + 40000 }, NOW + 40000);
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW + 50000 }, NOW + 50000);
  assert.strictEqual(onlineCalls(a.id).length, 4, '成功后不得重发');
});

test('REL-07 宽限期内恢复：不发，且回退路径不得在时长增长后补发', async () => {
  const a = db.createAgent({ name: 'rel07-grace-no-late' });
  const t0 = NOW - 60000;
  deliverOk = true;
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: t0 - 3600 * 1000 }, t0);
  resetCalls();
  // 离线 60s < 180s 宽限期 → 不发
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW }, NOW);
  assert.strictEqual(onlineCalls(a.id).length, 0, '宽限期内不应发');
  // 200s 后仍在 reporting：回退若未标记已处理，会算出 260s ≥ 180s 而补发
  const later = NOW + 200000;
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: later }, later);
  assert.strictEqual(onlineCalls(a.id).length, 0, '宽限期抑制后不得迟发补发');
});

// ---- 2. 指标恢复：失败重试 / 成功清状态 -------------------------------------

test('REL-07 指标恢复：投递失败保留 state 重试，成功才清且不重发', async () => {
  const a = db.createAgent({ name: 'rel07-metric-retry' });
  [95, 10, 10, 10, 10].forEach((v, i) => put(a.id, NOW - 50000 + i * 10000, { cpu: v }));
  db.setAlertState(a.id, 'cpu', NOW - 1000);
  resetCalls();

  deliverOk = false;
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW }, NOW);
  assert.strictEqual(calls.length, 1, '恢复应尝试投递');
  assert.ok(db.getAlertState(a.id, 'cpu'), '投递失败必须保留 state（旧实现此处已清 → 一次性丢失）');
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW + 10000 }, NOW + 10000);
  assert.strictEqual(calls.length, 2, '失败后下轮重试');

  deliverOk = true;
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW + 20000 }, NOW + 20000);
  assert.strictEqual(calls.length, 3, '成功轮投递一次');
  assert.ok(!db.getAlertState(a.id, 'cpu'), '投递成功后清 state');
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW + 30000 }, NOW + 30000);
  assert.strictEqual(calls.length, 3, '清状态后不得重发');
});

// ---- 3. REL-08 重启回退 ------------------------------------------------------

test('REL-08 重启后恢复：回退上一已关闭时段 ended_at 发上线通知，且不重发', async () => {
  const a = db.createAgent({ name: 'rel08-restart' });
  // 模拟重启前历史：1h 前离线（session 关闭于 NOW-3600s，reason=offline），
  // 本进程从未检查过该节点 ⇒ OFFLINE_SINCE 无值（等价进程重启）。
  const sid = db.openOnlineSession(a.id, NOW - 7200 * 1000);
  db.closeOnlineSession(sid, NOW - 3600 * 1000, 'offline');
  resetCalls();
  deliverOk = true;
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW }, NOW);
  const oc = onlineCalls(a.id);
  assert.strictEqual(oc.length, 1, '重启后恢复应回退持久化起点发通知');
  assert.ok(/离线约 3600s/.test(oc[0].text), `离线时长应取自 ended_at（实际：${oc[0].text}）`);
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW + 10000 }, NOW + 10000);
  assert.strictEqual(onlineCalls(a.id).length, 1, '回退成功后不得每轮重发');
});

test('REL-08 重启时节点一直在线：关闭段距今很近 → 宽限期抑制不误发', async () => {
  const a = db.createAgent({ name: 'rel08-online-through' });
  // 模拟启动清理把在线段关闭到 last_seen≈重启时刻（5s 前）
  const sid = db.openOnlineSession(a.id, NOW - 3600 * 1000);
  db.closeOnlineSession(sid, NOW - 5000, 'stale');
  resetCalls();
  deliverOk = true;
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW }, NOW);
  assert.strictEqual(onlineCalls(a.id).length, 0, '一直在线的节点重启后不应误发上线通知');
});

test('REL-08 新离线段重新置位：再次离线→恢复可再发', async () => {
  const a = db.createAgent({ name: 'rel08-rearm' });
  const sid = db.openOnlineSession(a.id, NOW - 7200 * 1000);
  db.closeOnlineSession(sid, NOW - 3600 * 1000, 'offline');
  resetCalls();
  deliverOk = true;
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW }, NOW);
  assert.strictEqual(onlineCalls(a.id).length, 1, '首次恢复发一次');
  // 再次离线 200s（新离线段，超宽限期）→ 恢复 → 应再发
  const t1 = NOW + 300000;
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: t1 - 3600 * 1000 }, t1);
  await alerts.checkAgent({ id: a.id, name: a.name, last_seen: t1 + 200000 }, t1 + 200000);
  assert.strictEqual(onlineCalls(a.id).length, 2, '新离线段后的恢复应再发');
});

// ---- 4. 基线：从未离线不误发 -------------------------------------------------

test('从未离线的节点不发上线通知（回退无已关闭时段）', async () => {
  const a = db.createAgent({ name: 'rel08-never-offline' });
  resetCalls();
  deliverOk = true;
  const r = await alerts.checkAgent({ id: a.id, name: a.name, last_seen: NOW }, NOW);
  assert.strictEqual(r, null, '无历史离线段不应产生任何通知任务');
  assert.strictEqual(onlineCalls(a.id).length, 0);
});