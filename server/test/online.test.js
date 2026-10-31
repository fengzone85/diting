'use strict';
// ============================================================
// 「在线」判定口径统一（回归）
//
// 真实缺陷（2026-10-26 核实并修复）：改造前有 4 套口径各自为政 ——
//   alerts.js        逐节点解析（节点 > 分组 > 全局）   ← 正确
//   compat.js        只看 OFFLINE_THRESHOLD_SEC env
//   v1.js            只看 OFFLINE_THRESHOLD_SEC env
//   ai/summarizer.js 只看全局 db.resolveAlertThresholds()
// 结果：面板把离线阈值调成非默认、或给某节点设了覆盖后会自相矛盾 ——
// 「面板/接口说在线，告警说离线并推通知」「AI 日报说在线，告警说离线」。
//
// 本测试守住两件事：
//   1) 结构上不再可能分裂：compat / v1 导出的 isOnline 就是 online.js 的同一个函数引用；
//   2) 取值链正确：节点覆盖 > 分组覆盖 > 全局（UI > env > 默认 60）。
// ============================================================
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DB = path.join(os.tmpdir(), `diting-online-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
delete process.env.OFFLINE_THRESHOLD_SEC;

const db = require('../src/db');
const online = require('../src/online');
const compat = require('../src/compat');
const v1 = require('../src/v1');

// 用真实当前时间，不能写死成某个历史日期：
// 本文件绝大多数用例把 NOW 显式传给 isOnline/onlineTtl，但 compat.toNode / v1.toNode
// 内部固定走 Date.now()，两者一旦相差几天，「200s 前上报应在线」就必然失败
// （写死 2026-10-26 后，该回归用例在之后每天都是红的）。
const NOW = Date.now();
// createAgent 返回的是创建时的行快照；改了 last_seen / 覆盖表之后必须重读，
// 否则断言用的是旧 last_seen（会被判成很久没上报）。
const reload = (id) => db.getAgent(id);
const setLastSeen = (id, ts) => db.db.prepare('UPDATE agents SET last_seen=? WHERE id=?').run(ts, id);
const setNodeOverride = (id, offlineSec) => db.db.prepare(
  `INSERT INTO alert_overrides (agent_id, offline_sec, updated_at) VALUES (?,?,?)
   ON CONFLICT(agent_id) DO UPDATE SET offline_sec=excluded.offline_sec`
).run(id, offlineSec, Date.now());
const setGroupOverride = (grp, offlineSec) => db.db.prepare(
  `INSERT INTO alert_group_overrides (grp, offline_sec, updated_at) VALUES (?,?,?)
   ON CONFLICT(grp) DO UPDATE SET offline_sec=excluded.offline_sec`
).run(grp, offlineSec, Date.now());

// 注意：不在 before 里删库文件 —— db 模块在 require 时就已建立连接，
// 删除重建会让连接指向已移动的文件（SQLITE_READONLY_DBMOVED）。
// TMP_DB 名字含 pid + 时间戳，本身唯一，无需预清理。
after(() => {
  delete process.env.OFFLINE_THRESHOLD_SEC;
  for (const sfx of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + sfx); } catch { /* 忽略 */ }
  }
});

test('结构一致：compat / v1 导出的是 online 的同一个函数引用', () => {
  assert.strictEqual(compat.isOnline, online.isOnline,
    'compat.isOnline 必须是 online.isOnline 本身，不能再有第二份实现');
  assert.strictEqual(v1.isOnline, online.isOnline,
    'v1.isOnline 必须是 online.isOnline 本身，不能再有第二份实现');
});

test('默认阈值：未设 UI / env 时为 60 秒', () => {
  const a = db.createAgent({ name: 'online-default' });
  setLastSeen(a.id, NOW - 30 * 1000);   // 30s 前上报 → 在线
  assert.strictEqual(online.isOnline(reload(a.id), NOW), true);

  setLastSeen(a.id, NOW - 90 * 1000);   // 90s 前 → 离线
  assert.strictEqual(online.isOnline(reload(a.id), NOW), false);
});

test('env 口径：OFFLINE_THRESHOLD_SEC=120 后 90s 前上报算在线', () => {
  const a = db.createAgent({ name: 'online-env' });
  setLastSeen(a.id, NOW - 90 * 1000);
  process.env.OFFLINE_THRESHOLD_SEC = '120';
  try {
    assert.strictEqual(online.isOnline(reload(a.id), NOW), true, 'env 阈值 120s 下 90s 应算在线');
  } finally {
    delete process.env.OFFLINE_THRESHOLD_SEC;
  }
  assert.strictEqual(online.isOnline(reload(a.id), NOW), false, '恢复默认 60s 后应算离线');
});

test('节点覆盖优先：节点设 300s 时 env=120 也要让位', () => {
  const a = db.createAgent({ name: 'online-node-ovr' });
  setLastSeen(a.id, NOW - 240 * 1000);  // 4 分钟前
  setNodeOverride(a.id, 300);
  process.env.OFFLINE_THRESHOLD_SEC = '120';
  try {
    assert.strictEqual(online.isOnline(reload(a.id), NOW), true, '节点覆盖 300s 应生效（不看 env 的 120）');
  } finally {
    delete process.env.OFFLINE_THRESHOLD_SEC;
  }
  assert.strictEqual(online.isOnline(reload(a.id), NOW), true);
});

test('分组覆盖：节点未覆盖时按分组值判定', () => {
  const a = db.createAgent({ name: 'online-grp', grp: 'room-a' });
  setLastSeen(a.id, NOW - 200 * 1000);  // 200s 前
  setGroupOverride('room-a', 600);
  assert.strictEqual(online.isOnline(reload(a.id), NOW), true, '分组 600s 下 200s 应算在线');

  // 同组另一台：节点覆盖会压过分组
  const b = db.createAgent({ name: 'online-grp2', grp: 'room-a' });
  setLastSeen(b.id, NOW - 200 * 1000);
  setNodeOverride(b.id, 100);
  assert.strictEqual(online.isOnline(reload(b.id), NOW), false, '节点覆盖 100s 应压过分组的 600s');
});

test('ttl 语义：正数=距离线的剩余毫秒，负数=已离线多久', () => {
  const a = db.createAgent({ name: 'online-ttl' });
  setLastSeen(a.id, NOW - 20 * 1000);
  assert.strictEqual(online.onlineTtl(reload(a.id), NOW), 40 * 1000, '默认 60s 阈值下已过 20s → 剩 40s');

  setLastSeen(a.id, NOW - 100 * 1000);
  assert.strictEqual(online.onlineTtl(reload(a.id), NOW), -40 * 1000, '已过 100s → 离线 40s');
});

test('无 last_seen 视为离线（ttl 为负）', () => {
  const a = db.createAgent({ name: 'online-noseen' });
  db.db.prepare('UPDATE agents SET last_seen=NULL WHERE id=?').run(a.id);
  const row = db.getAgent(a.id);
  assert.strictEqual(online.isOnline(row, NOW), false);
  assert.ok(online.onlineTtl(row, NOW) < 0);
});

test('回归核心：compat.toNode 的 online 与 online.isOnline 同源（阈值覆盖下也一致）', () => {
  const a = db.createAgent({ name: 'online-compat', grp: 'g-compat' });
  setLastSeen(a.id, NOW - 200 * 1000);
  setGroupOverride('g-compat', 600);            // 分组放宽 → 应判在线
  const row = db.getAgent(a.id);
  // 传同一个 NOW：此前两次调用各自 Date.now()，跨毫秒时 ttl 会差 1ms 而随机失败。
  const octx = online.buildCtx();
  const node = compat.toNode(row, false, octx, NOW);
  assert.strictEqual(node.online, online.isOnline(row, NOW, octx), 'toNode 的 online 必须与统一口径一致');
  assert.strictEqual(node.online, true, '分组 600s 覆盖下 200s 应算在线（旧实现只看 env=60 会判离线）');
  assert.strictEqual(node.ttl, online.onlineTtl(row, NOW, octx), 'toNode 的 ttl 同样必须同源');
});
