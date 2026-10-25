'use strict';
// ============================================================
// F12 容量保险丝回归
//
// 锚定行为（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md §5 F12）：
//   1. 行数/库字节双水位，先到者触发；80% warn、100% full；
//   2. full 时只停写 metrics —— /report 仍 200、流量累加/在线状态继续；
//   3. 跳过写入要计数（status.skipped）；
//   4. 一键清理只跑 retention prune，清理后重新评估；
//   5. 清理接口鉴权 + 审计。
// ============================================================
process.env.DB_PATH = '/tmp/diting-capacity-test.db';
process.env.BACKUP_DIR = '/tmp/diting-capacity-test-backups';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* ignore */ }
}
fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true });
fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true });

const db = require('../src/db');
const capacity = require('../src/capacity');

const DAY = 86400000;

test('computeLevel：79.9% 正常、80% 预警、100% 硬限（行数/字节先到者）', () => {
  const lv = (rows, bytes) => capacity.computeLevel({ rows, bytes, max_rows: 1000, max_bytes: 1000000 });
  assert.strictEqual(lv(799, 0).level, 'ok');
  assert.strictEqual(lv(800, 0).level, 'warn');
  assert.strictEqual(lv(999, 0).level, 'warn');
  assert.strictEqual(lv(1000, 0).level, 'full');
  // 字节维度先到
  assert.strictEqual(lv(0, 799999).level, 'ok');
  assert.strictEqual(lv(0, 800000).level, 'warn');
  assert.strictEqual(lv(0, 1000000).level, 'full');
  assert.strictEqual(lv(0, 2000000).level, 'full');
});

test('full 时 shouldWriteHistory=false 且跳过计数递增', () => {
  const a = db.createAgent({ name: 'capacity-agent' });
  db.insertMetric(a.id, { ts: Date.now() });
  // 阈值 1 行：当前 1 行 → 100%
  db.setUiSettings({ capacity_enabled: true, capacity_max_rows: 1, capacity_max_mb: 2048 });
  capacity._resetForTest();

  assert.strictEqual(capacity.shouldWriteHistory(), false, '硬限时应停写历史');
  const s = capacity.getStatus({ refresh: true });
  assert.strictEqual(s.level, 'full');
  assert.strictEqual(s.paused, true);
  assert.ok(s.skipped >= 1, '跳过写入应计数');
  assert.strictEqual(s.enabled, true);
});

test('cleanup：按 retention 清理过期明细并重新评估', () => {
  const a = db.createAgent({ name: 'capacity-cleanup' });
  for (let i = 0; i < 3; i++) db.insertMetric(a.id, { ts: Date.now() - 40 * DAY });
  // 先切回正常阈值，避免「仍 full」干扰断言
  db.setUiSettings({ capacity_enabled: true, capacity_max_rows: 2000000, capacity_max_mb: 2048 });
  capacity._resetForTest();

  const before = db.db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n;
  const r = capacity.cleanup();
  const after = db.db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n;
  assert.ok(r.deleted >= 3, `应删除过期行：deleted=${r.deleted}`);
  assert.strictEqual(before - after, r.deleted);
  assert.strictEqual(r.paused, false, '清理后应低于阈值');
  assert.strictEqual(r.level, 'ok');
});

test('/report 在硬限时仍 200、metrics 不增，且实时状态继续；清理接口鉴权/审计', async () => {
  process.env.PORT = '0';
  process.env.ADMIN_ALLOW_HTTP = '1';
  process.env.ADMIN_TOKEN = 'capacity-admin-token-0123456789abcdef';
  // eslint-disable-next-line global-require
  const { app, server } = require('../server');
  const request = require('supertest');
  try {
    const a = db.createAgent({ name: 'capacity-report' });
    db.setUiSettings({ capacity_enabled: true, capacity_max_rows: 1, capacity_max_mb: 2048 });
    capacity._resetForTest();

    const auth = { 'X-Agent-ID': a.id, Authorization: `Bearer ${a.token}` };
    const base = {
      cpu: 1, mem_used: 1, mem_total: 2, mem_pct: 50,
      net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0,
      os: 'Linux', hostname: 'capacity-report'
    };
    const before = db.db.prepare('SELECT COUNT(*) AS n FROM metrics WHERE agent_id=?').get(a.id).n;
    const r = await request(app).post('/api/report').set(auth).set('X-Forwarded-Proto', 'https')
      .send(Object.assign({}, base, { net_rx: 100, net_tx: 50, month_rotate: 0 }));
    assert.strictEqual(r.status, 200, '硬限时 /report 必须仍 200');
    const after = db.db.prepare('SELECT COUNT(*) AS n FROM metrics WHERE agent_id=?').get(a.id).n;
    assert.strictEqual(after, before, '硬限时不应写历史明细');

    // 实时链路继续：流量累加器仍然更新（flush 后可见）
    db.flushTraffic();
    const st = db.db.prepare('SELECT * FROM traffic_state WHERE agent_id=?').get(a.id);
    assert.ok(st, '流量状态应继续写入');
    assert.strictEqual(st.used_rx, 100);

    const un = await request(app).post('/api/admin/capacity/cleanup');
    assert.strictEqual(un.status, 401, '未鉴权应 401');

    const admin = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };
    const status = await request(app).get('/api/admin/capacity').set(admin);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.level, 'full');
    assert.strictEqual(status.body.paused, true);

    const clean = await request(app).post('/api/admin/capacity/cleanup').set(admin);
    assert.strictEqual(clean.status, 200);
    const log = db.getAuditLogs(10, 0).find((l) => l.action === 'capacity_cleanup');
    assert.ok(log, '应写 capacity_cleanup 审计');
    assert.match(log.detail, /level=/);
  } finally {
    server.close();
    fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true });
  }
});
