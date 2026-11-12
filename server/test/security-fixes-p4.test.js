'use strict';
// ============================================================
// P1 批量回归（安全/数据面）：
//   P1-1  匿名 /api/logout 不得全量撤销会话（会话可用性 DoS）
//   P1-2  分组计费按归一化币种查汇率（¥/￥/CNY 同源，未知币种不隐式 1:1）
//   P1-3  AI Provider SSRF：::ffff: 映射/带括号形不得绕过 IMDS 黑名单
//   P1-4  只读 Token 不得读到通知渠道凭据；编辑响应不回声 headers 值
//   P1-5  TOTP 失败锁定按 IPv6 /64 归桶
//   P1-6  public_remark 受 public_show_business 门控
//   P1-7  软删节点的历史指标不出现在合并/探针查询
//   P1-9  WS maxPayload 1MiB，超限 1009 关闭
// ============================================================
process.env.PORT = '0';
process.env.DB_PATH = '/tmp/diting-p1-fixes-test.db';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'p1-fixes-admin-token-0123456789abcdef';
process.env.READONLY_TOKEN = 'p1-fixes-readonly-token-0123456789abcd';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const { totpGuard, recordTotpFailure, clearTotpFailures } = require('../src/auth');
const { checkBaseUrl } = require('../src/ai/provider');

after(async () => {
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN };
const READONLY = { 'X-Readonly-Token': process.env.READONLY_TOKEN };

function watermark() {
  return Number(db.getConfig('session_revoked_before') || 0);
}

test('P1-1 匿名 logout：revoked=false、水位线不变、不写审计', async () => {
  const before = watermark();
  const r = await request(app).post('/api/logout');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true, revoked: false }, '匿名请求不得全量撤销');
  assert.strictEqual(watermark(), before, '会话水位线不得推进（负向对照：修前会被推进）');

  const r2 = await request(app).post('/api/logout?all=1');
  assert.strictEqual(r2.body.revoked, false, '?all=1 也不能让匿名者全量撤销');
  assert.strictEqual(watermark(), before);
});

test('P1-1 管理员 logout：?all 撤销全部，?all=0 只清 Cookie', async () => {
  const before = watermark();
  const r = await request(app).post('/api/logout?all=0').set(ADMIN);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.revoked, false, '?all=0 只清 Cookie');
  assert.strictEqual(watermark(), before);

  const r2 = await request(app).post('/api/logout').set(ADMIN);
  assert.strictEqual(r2.body.revoked, true, '管理员默认全量撤销');
  assert.ok(watermark() > before, '水位线应推进');
});

test('P1-2 分组计费：¥ 归一化命中 CNY 汇率，未知币种不隐式 1:1', async () => {
  const a = db.createAgent({
    name: 'bill-yen', grp: 'G1', price: 300, billing_cycle: 30, currency: '¥',
    expire_at: Date.now() + 30 * 86400000,
  });
  db.createAgent({
    name: 'bill-unknown', grp: 'G2', price: 300, billing_cycle: 30, currency: 'XYZ',
    expire_at: Date.now() + 30 * 86400000,
  });

  const r = await request(app).get('/api/billing').set(ADMIN);
  assert.strictEqual(r.status, 200);
  const g1 = r.body.per_group.find((x) => x.name === 'G1');
  const g2 = r.body.per_group.find((x) => x.name === 'G2');
  assert.ok(g1 && g1.cost > 0, `¥ 应命中 CNY 汇率使 per_group 非 0，实际 ${JSON.stringify(g1)}`);
  assert.ok(g2 && g2.cost === 0, '未知币种不得被隐式按 1:1/CNY 计价');
  assert.ok((r.body.missing || []).includes('XYZ') || (r.body.by_currency.XYZ && r.body.by_currency.XYZ.rate == null),
    '未知币种应进入 missing / rate=null 可见');
});

test('P1-3 Provider SSRF：映射 IPv6/带括号形拒绝，localhost 放行', async () => {
  for (const url of [
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://169.254.169.254/',
    'http://[::ffff:169.254.169.254]:80/v1',
  ]) {
    await assert.rejects(() => checkBaseUrl(url), /云元数据|禁止/, `应拒绝 ${url}`);
  }
  // 负向对照：删掉 normalizeIpLiteral 归一化后上面前三行会放行
  await checkBaseUrl('http://localhost:11434/v1'); // 本地 Ollama 场景必须放行
  await checkBaseUrl('http://127.0.0.1:8080/v1');
});

test('P1-4 通知渠道：只读无凭据、编辑响应不回声 headers 值', async () => {
  const created = await request(app).post('/api/admin/notify/channels').set(ADMIN).send({
    type: 'webhook', name: 'p1-hook', enabled: true,
    config: { url: 'https://hooks.example.com/secret-path?token=abc', headers: { Authorization: 'Bearer s3cret' } },
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.config.headers.Authorization, '***', '编辑响应不得回声 headers 值');

  const ro = await request(app).get('/api/admin/notify/channels').set(READONLY);
  assert.strictEqual(ro.status, 200);
  const item = ro.body.find((c) => c.name === 'p1-hook');
  assert.ok(item, '只读列表应非空');
  assert.ok(!JSON.stringify(item).includes('s3cret'), '只读响应不得含凭据');
  assert.ok(!JSON.stringify(item).includes('secret-path'), '只读响应不得含完整 URL');
  assert.strictEqual(item.config.url_host, 'hooks.example.com', '最多留 URL 主机名');

  const admin = await request(app).get('/api/admin/notify/channels').set(ADMIN);
  const full = admin.body.find((c) => c.name === 'p1-hook');
  assert.ok(full.config.url.includes('secret-path'), '管理员列表保留原始数据（编辑流程不受影响）');
});

test('P1-5 TOTP 失败锁定按 IPv6 /64 归桶', () => {
  clearTotpFailures({ ip: '2001:db8:aaaa:bbbb::1' });
  clearTotpFailures({ ip: '2001:db8:aaaa:cccc::1' });
  clearTotpFailures({ ip: '1.2.3.4' });
  // 同 /64 不同接口地址共享失败计数
  for (let i = 0; i < 30; i++) recordTotpFailure({ ip: '2001:db8:aaaa:bbbb::1' });
  assert.strictEqual(totpGuard({ ip: '2001:db8:aaaa:bbbb::1' }), false);
  assert.strictEqual(totpGuard({ ip: '2001:db8:aaaa:bbbb::9999' }), false, '同 /64 另一地址必须共享锁定');
  // 不同 /64 与 IPv4 不受影响
  assert.strictEqual(totpGuard({ ip: '2001:db8:aaaa:cccc::1' }), true);
  assert.strictEqual(totpGuard({ ip: '1.2.3.4' }), true);
});

test('P1-6 公开备注受 public_show_business 门控', async () => {
  const a = db.createAgent({ name: 'remark-node', note: '商户A-用途X' });
  const show = db.getUiSettings();
  db.setUiSettings(Object.assign({}, show, { public_show_business: true }));
  let r = await request(app).get('/api/nodes');
  let node = (r.body.nodes || r.body).find?.((n) => n.uuid === a.id || n.id === a.id) || null;
  if (!node) {
    // 兼容层返回形状兜底：直接扫 JSON
    assert.ok(JSON.stringify(r.body).includes('商户A-用途X'), '开启时备注应可见');
  }

  db.setUiSettings(Object.assign({}, db.getUiSettings(), { public_show_business: false }));
  r = await request(app).get('/api/nodes');
  assert.ok(!JSON.stringify(r.body).includes('商户A-用途X'), '关闭后兼容层不得泄露备注（负向对照：修前会泄露）');
  db.setUiSettings(Object.assign({}, db.getUiSettings(), { public_show_business: true }));
});

test('P1-7 软删节点历史指标从合并/探针查询消失，恢复后重现', () => {
  const id = db.createAgent({ name: 'soft-del-metrics' }).id;
  const now = Date.now();
  db.insertMetric(id, {
    ts: now - 60000, cpu: 1, mem_used: 0, mem_total: 0, mem_pct: 0,
    disk_used: 0, disk_total: 0, disk_pct: 0, load1: 0, load5: 0, load15: 0,
    net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0,
    uptime: 0, process_count: 0,
    probes: JSON.stringify({ t: { ms: 5, ok: true, loss: 0 } }),
  });

  let rows = db.getMetricsProbesOne(id, now - 3600000, 100);
  assert.ok(rows.length > 0, '删除前应有数据');

  db.deleteAgent(id);
  rows = db.getMetricsProbesOne(id, now - 3600000, 100);
  assert.strictEqual(rows.length, 0, '软删后探针序列必须消失（负向对照：修前仍返回）');

  db.restoreAgent(id);
  rows = db.getMetricsProbesOne(id, now - 3600000, 100);
  assert.ok(rows.length > 0, '恢复后历史重新可见');
});

test('P1-9 WS maxPayload：超 1MiB 帧以 1009 关闭', async () => {
  const WebSocket = require('ws');
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/clients`);
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } reject(new Error('WS 超时')); }, 5000);
    ws.on('open', () => ws.send(Buffer.alloc(2 * 1024 * 1024)));
    ws.on('close', (code) => {
      clearTimeout(timer);
      try {
        assert.strictEqual(code, 1009, `超限帧应以 1009 关闭，实际 ${code}`);
        resolve();
      } catch (e) { reject(e); }
    });
    ws.on('error', () => { /* close 事件负责断言 */ });
  });
});
