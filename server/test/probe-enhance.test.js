'use strict';
// ============================================================
// F4 探测增强回归：HTTP/TLS 探测字段、可用率聚合、证书到期告警
//
// 锚定行为（dev-docs/IMPLEMENTATION_PLAN_2026-10-19.md F4）：
//   1. validateReport 接受 probes 的 type/code/cert_days，非法值降级而不丢整条；
//      老 agent（不带 type）默认按 tcp 处理，旧字段语义不变。
//   2. GET /api/public/agents/:id/probes 默认仍返回「纯 series 对象」，
//      ?availability=1 才返回 { series, availability }（形状兼容）。
//   3. availability 口径：分母为窗口内全部采样点，unreachable 表示全失败。
//   4. cert 告警：cert_days 按上报时间衰减，≤ CERT_WARN_DAYS 触发，24h 冷却，
//      全部恢复后清 state。
//
// 运行前提与 alert-rules.test.js 相同：PORT=0 / 临时 DB / 禁真实 SMTP。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'probe-enhance-admin-token-0123456789';
process.env.DB_PATH = '/tmp/diting-probe-enhance-test.db';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.CERT_WARN_DAYS = '14';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');
const alerts = require('../src/alerts');
const { validateReport } = require('../src/validate');

db.setConfig('notify_config', JSON.stringify({
  smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: ''
}));

after(async () => {
  alerts.stop();
  try { server.closeAllConnections?.(); } catch { /* 旧版 Node 无此 API */ }
  try { await new Promise((r) => server.close(r)); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// 桩掉 https.request，让 Telegram 通道「发送成功」；否则 sendAlertGuarded
// 会因无可用通道回滚 state，观测不到冷却语义（同 security-fixes-p2.test.js）。
function stubTelegramOk() {
  const https = require('node:https');
  const real = https.request;
  https.request = (opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const req = new EventEmitter();
    req.write = () => {};
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => { cb(res); res.emit('data', '{"ok":true}'); res.emit('end'); });
    return req;
  };
  db.setConfig('notify_config', JSON.stringify({
    telegram_bot_token: 'test-bot-token', telegram_chat_id: '123'
  }));
  return () => {
    https.request = real;
    db.setConfig('notify_config', JSON.stringify({
      smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: ''
    }));
  };
}

// ---- 1. 校验层 -------------------------------------------------------------

test('F4 validate：type/code/cert_days 透传，非法值降级，老格式默认 tcp', () => {
  const out = validateReport({
    hostname: 'h', os: 'linux',
    probes: {
      web: { ms: 12.4, ok: true, loss: 0, type: 'http', code: 200, cert_days: 30 },
      bad: { ms: 5, ok: true, loss: 0, type: 'icmp', code: 999, cert_days: 4000 },
      legacy: { ms: 8, ok: true, loss: 0 },
    },
  });
  const p = JSON.parse(out.probes);

  assert.deepStrictEqual(p.web, { ms: 12.4, ok: true, loss: 0, type: 'http', code: 200, cert_days: 30 });
  // 未知 type → 缺省 tcp（不落 type 字段）；越界 code / cert_days → 丢字段而非整条
  assert.ok(!('type' in p.bad), '非 http 不落 type（tcp 为缺省语义）');
  assert.ok(!('code' in p.bad), 'code 越界应被丢弃');
  assert.ok(!('cert_days' in p.bad), 'cert_days 越界应被丢弃');
  assert.strictEqual(p.bad.ms, 5, '其余字段不受影响');
  // 老 agent：无 type → 缺省 tcp，且保持原 {ms,ok,loss} 形状不变
  assert.deepStrictEqual(p.legacy, { ms: 8, ok: true, loss: 0 });
});

// ---- 2. 可用率聚合 ---------------------------------------------------------

test('F4 API：默认响应形状不变；?availability=1 返回可用率与证书元信息', async () => {
  const { id } = db.createAgent({ name: 'probe-api-node' });
  const now = Date.now();
  const mk = (ts, probes) => db.insertMetric(id, { ts, probes: JSON.stringify(probes) });

  mk(now - 3 * 60000, { web: { ms: 100, ok: true, loss: 0, type: 'http', code: 200, cert_days: 10 } });
  mk(now - 2 * 60000, { web: { ms: 300, ok: true, loss: 0, type: 'http', code: 204, cert_days: 9 } });
  mk(now - 1 * 60000, {
    web: { ms: null, ok: false, loss: 100, type: 'http', code: 500, cert_days: 8 },
    down: { ms: null, ok: false, loss: 100, type: 'tcp' },
  });

  // 兼容：不带参数时仍是 { "<label>": [点...] }
  const legacy = await request(app).get(`/api/public/agents/${id}/probes?range=24h`);
  assert.strictEqual(legacy.status, 200);
  assert.ok(Array.isArray(legacy.body.web), '默认响应必须是纯 series');
  assert.ok(!('series' in legacy.body), '不得改变既有响应形状');

  const r = await request(app).get(`/api/public/agents/${id}/probes?range=24h&availability=1`);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.series.web), 'availability=1 时 series 仍在');

  const av = r.body.availability.web;
  assert.strictEqual(av.samples, 3);
  assert.strictEqual(av.down_samples, 1);
  assert.strictEqual(av.up_pct, 66.7, '分母 = 全部样本，保留 1 位小数');
  assert.strictEqual(av.avg_ms, 200, 'avg 只统计有效 ms');
  assert.strictEqual(av.max_ms, 300);
  assert.strictEqual(av.last_down_at, now - 60000);
  assert.strictEqual(av.unreachable, false);
  assert.strictEqual(av.type, 'http');
  assert.strictEqual(av.code, 500, '取最新一条的状态码');
  assert.strictEqual(av.cert_days, 8, '取最新一条的证书剩余天数');
  assert.strictEqual(av.cert_ts, now - 60000);

  const down = r.body.availability.down;
  assert.strictEqual(down.samples, 1);
  assert.strictEqual(down.up_pct, 0);
  assert.strictEqual(down.unreachable, true, '全失败应标记不可达（区别于 0% 可用）');
  assert.strictEqual(down.type, 'tcp');
  assert.strictEqual(down.avg_ms, null, '无有效 ms 时为 null');
});

// ---- 3. 证书到期告警 -------------------------------------------------------

test('F4 alerts：cert_days ≤ 阈值触发 cert 告警，24h 冷却，恢复清状态', async () => {
  const restore = stubTelegramOk();
  try {
    const { id } = db.createAgent({ name: 'cert-node' });
    const now = Date.now();
    const put = (ts, certDays) => db.insertMetric(id, {
      ts,
      probes: JSON.stringify({ web: { ms: 10, ok: true, loss: 0, type: 'http', code: 200, cert_days: certDays } }),
    });

    put(now, 5);
    await alerts.checkCertExpiry(now);
    const st = db.getAlertState(id, 'cert');
    assert.ok(st, '低于阈值应写 cert 状态');
    const firstSent = st.last_sent;

    // 冷却窗口内不重复（快照未变）
    await alerts.checkCertExpiry(now + 3600 * 1000);
    assert.strictEqual(db.getAlertState(id, 'cert').last_sent, firstSent, '24h 冷却内不重复发送');

    // 证书续签到 60 天 → 恢复并清状态
    put(now + 2 * 3600 * 1000, 60);
    await alerts.checkCertExpiry(now + 2 * 3600 * 1000);
    assert.ok(!db.getAlertState(id, 'cert'), '全部高于阈值后应清除状态');
  } finally {
    restore();
  }
});

test('F4 alerts：cert_days 越旧越少（按上报时间衰减），旧快照不会停在阈值外', async () => {
  const restore = stubTelegramOk();
  try {
    const { id } = db.createAgent({ name: 'cert-stale-node' });
    const now = Date.now();
    // 上报时剩 20 天（高于阈值 14），但快照已是 10 天前的 → 实际剩 10 天，应触发
    db.insertMetric(id, {
      ts: now - 10 * 86400000,
      probes: JSON.stringify({ web: { ms: 10, ok: true, loss: 0, type: 'http', code: 200, cert_days: 20 } }),
    });
    await alerts.checkCertExpiry(now);
    assert.ok(db.getAlertState(id, 'cert'), '衰减后低于阈值应触发');
  } finally {
    restore();
  }
});

// ---- 4. F4 收口：可用率取数改走 heavy worker --------------------------------
// 为什么要 worker：公开端点未认证即可触发，30d 窗口的 SQL 采样 + JSON.parse
// 在主线程执行会阻塞事件循环（期间 /report 与告警全部挂起）。
test('F4 收口：公开 probes 端点的取数走 heavy worker（不走主线程 SQL）', async () => {
  const fsx = require('node:fs');
  const path = require('node:path');
  const src = fsx.readFileSync(path.join(__dirname, '..', 'src', 'api.js'), 'utf8');
  // 取出该路由的源码片段（到下一个 router. 定义为止）
  const start = src.indexOf("router.get('/public/agents/:id/probes'");
  assert.ok(start > 0, '应能找到公开 probes 路由');
  const rest = src.slice(start);
  const end = rest.indexOf('\nrouter.', 10);
  const seg = end > 0 ? rest.slice(0, end) : rest;
  assert.ok(seg.includes("heavyQuery('probesOne'"), '该路由应通过 heavyQuery 取数');
  assert.ok(!seg.includes('db.getMetricsProbesOne('), '该路由不应再直接调用主线程 SQL');

  // worker 路径与主线程回落路径必须口径一致（worker 不可用时 heavy-db 自动回落）
  const { heavyQuery } = require('../src/heavy-db');
  const id = db.createAgent({ name: 'f4-worker-check' }).id;
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    db.insertMetric(id, {
      ts: now - i * 60000, cpu: 1, mem_used: 1, mem_total: 2, mem_pct: 50,
      disk_used: 1, disk_total: 2, disk_pct: 50, load1: 0, load5: 0, load15: 0,
      net_rx_rate: 0, net_tx_rate: 0, net_rx_month: 0, net_tx_month: 0,
      uptime: 1, temp: null, swap_used: 0, swap_total: 0, swap_pct: 0,
      disk_r_rate: 0, disk_w_rate: 0, process_count: 1, interval: 20,
      probes: JSON.stringify({ web: { ms: 10 + i, ok: true, loss: 0, type: 'http', code: 200, cert_days: 30 } }),
      disks: null
    });
  }
  const since = now - 3600000;
  const viaWorker = await heavyQuery('probesOne', id, since, 5000);
  const viaMain = db.getMetricsProbesOne(id, since, 5000);
  assert.ok(Array.isArray(viaWorker), 'worker 路径应返回数组');
  assert.deepStrictEqual(viaWorker.map((r) => r.ts), viaMain.map((r) => r.ts),
    'worker 与主线程回落路径的取数结果必须一致');
});
