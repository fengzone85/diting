'use strict';
// ============================================================
// 安全审查修复（第二批，P2）的回归断言（SECURITY_REVIEW_2026-10-17.md 行动计划）
//
// 运行前提与 integration.api.test.js 相同：PORT=0 / ADMIN_ALLOW_HTTP=1 /
// 测试专用 ADMIN_TOKEN / DB_PATH 指向 /tmp 临时库（绝不触碰生产 monitor.db）。
//
// 锚定修复的行为：
//   C3/C-3 — rateLimitTouch：表满不清表（当前 IP 计数不被清零）+ 惰性过期；
//   C-4    — /api/setup/generate 无 HTTPS 头且未开 ADMIN_ALLOW_HTTP → 403；
//   G5     — /api/version 匿名与认证均回完整版本（2026-10-21 页脚需要，显式放开收敛）；
//   E1/E6  — 单样本 spike 不报、连续 N 个采样才报、恢复发一次并清状态、
//            磁盘/温度纳入告警；
//   E4     — 已过期节点独立终态 + 7 天冷却；
//   E5     — trafficEstimateBucketed 按小时桶积分、异常间隔不计。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'sectest2-admin-token-0123456789abcdef';
process.env.DB_PATH = '/tmp/diting-security-fixes-p2-test.db';
// 禁服真实通知：仓库 .env 含 SMTP 占位符，dotenv 会把它注入 env 并激活邮件通道，
// 导致测试真实联网连接 smtp.qq.com（认证失败、拖慢、污染）。dotenv 不覆盖已设
// env，故在此显式置空——getNotifyConfig 的环境变量默认值随之失效，邮件通道关闭。
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
const { rateLimitTouch } = require('../src/ratelimit');

// 测试环境禁服真实通知：仓库 .env 含 SMTP 占位符，会激活邮件通道并真实联网
// （连接 smtp.qq.com 认证失败，拖慢且污染测试）。直接写原始配置绕过
// setNotifyConfig 的"空值保持"逻辑，确保所有通道关闭。
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

// ---- C3/C-3：限流表语义 ------------------------------------------------------

test('rateLimitTouch：表满时不清表——当前 IP 的计数不被清零（审查 C3）', () => {
  const m = new Map();
  // 用长窗口（10 分钟）填满到 MAP_CAP，全程无过期
  for (let i = 0; i < 10000; i++) rateLimitTouch(m, 'filler-' + i, 600000, 1000);
  assert.strictEqual(m.size, 10000);
  // 若实现是"先 clear 后 set"，攻击者计数会在表满时被清零，永远达不到上限
  assert.strictEqual(rateLimitTouch(m, 'attacker', 600000, 2), true);
  assert.strictEqual(rateLimitTouch(m, 'attacker', 600000, 2), true);
  assert.strictEqual(rateLimitTouch(m, 'attacker', 600000, 2), false, '第 3 次必须被拒（计数未被清空）');
});

test('rateLimitTouch：窗口过期后重新计数（惰性过期，无整表清空定时器）', () => {
  const m = new Map();
  assert.strictEqual(rateLimitTouch(m, 'ip', 60000, 1), true);
  assert.strictEqual(rateLimitTouch(m, 'ip', 60000, 1), false, '窗口内第 2 次被拒');
  m.get('ip').reset = Date.now() - 1; // 模拟窗口到期
  assert.strictEqual(rateLimitTouch(m, 'ip', 60000, 1), true, '过期后重新放行');
});

// ---- C-4：初始化端点 HTTPS 强制 ----------------------------------------------
// 语义演进（T1.7）：requireProto 增加"回环 + 零代理头"例外，供安装向导的 ssh -L 隧道使用；
// 但**经反向代理**的明文请求必须继续拒绝（那正是 Token 明文回显的真实风险面）。

test('POST /api/setup/generate：经明文反代（X-Forwarded-Proto: http）→ 403（审查 C-4）', async () => {
  const backup = process.env.ADMIN_ALLOW_HTTP;
  delete process.env.ADMIN_ALLOW_HTTP;
  try {
    const res = await request(app).post('/api/setup/generate')
      .set({ 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'http' })
      .send({});
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, 'https required');
  } finally {
    process.env.ADMIN_ALLOW_HTTP = backup;
  }
});

test('requireProto 判定矩阵：本机/内网例外仅在"零代理头"时成立', () => {
  const { requireProto } = require('../src/auth');
  const mkRes = () => ({
    code: 0, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  });
  const mkReq = (addr, headers = {}) => ({
    socket: { remoteAddress: addr },
    headers,
    header: (k) => headers[String(k).toLowerCase()],
  });
  const backup = process.env.ADMIN_ALLOW_HTTP;
  delete process.env.ADMIN_ALLOW_HTTP;
  try {
    // ① 本机/内网 + 无任何代理头 → 放行（ssh -L 隧道、安装向导入口）
    //    172.17.0.1 是 Docker 端口发布后的容器侧来源地址（T1.9 实测），必须放行，
    //    否则安装器打印的隧道提示在 Docker 部署下必然 403。
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.5', '192.168.1.2', '172.17.0.1', '172.31.255.254', 'fd00::1']) {
      const res = mkRes();
      assert.strictEqual(requireProto(mkReq(addr), res), true, `${addr} 直连应放行`);
      assert.strictEqual(res.code, 0, '放行时不应写响应');
    }
    // ② 内网来源但带代理头：nginx 以 http 转发 → 拒绝（伪造/明文暴露两道防线）
    for (const h of [
      { 'x-forwarded-for': '203.0.113.9' },
      { 'x-real-ip': '203.0.113.9' },
      { forwarded: 'for=203.0.113.9' },
      { 'x-forwarded-proto': 'http' },
    ]) {
      const res = mkRes();
      assert.strictEqual(requireProto(mkReq('127.0.0.1', h), res), false, `${JSON.stringify(h)} 应拒绝`);
      assert.strictEqual(res.code, 403);
    }
    // ③ 公网来源直连（无代理头）→ 拒绝，与改动前一致
    for (const addr of ['203.0.113.9', '8.8.8.8', '2001:db8::1']) {
      const res = mkRes();
      assert.strictEqual(requireProto(mkReq(addr), res), false, `${addr} 应拒绝`);
      assert.strictEqual(res.code, 403);
    }
    // ④ 显式 https 头 → 放行（任何来源）
    assert.strictEqual(requireProto(mkReq('203.0.113.9', { 'x-forwarded-proto': 'https' }), mkRes()), true);
  } finally {
    if (backup === undefined) delete process.env.ADMIN_ALLOW_HTTP;
    else process.env.ADMIN_ALLOW_HTTP = backup;
  }
});

// ---- G5：版本披露收敛 ---------------------------------------------------------

test('GET /api/version：匿名与认证均回完整版本与构建时间（2026-10-21 放开 G5 收敛）', async () => {
  const anon = await request(app).get('/api/version');
  assert.strictEqual(anon.status, 200);
  // 页脚需要在未登录时显示「版本 (commit)」，故匿名同样返回完整版本号与构建时间。
  assert.ok(anon.body.version.includes('.'), `匿名回完整版本号，实际 ${anon.body.version}`);
  assert.ok(anon.body.build_time, '匿名回构建时间');
  assert.strictEqual(anon.body.data.version, anon.body.version, '信封与顶层的版本号一致');

  const auth = await request(app).get('/api/version').set(ADMIN);
  assert.ok(auth.body.build_time, '认证后回完整版本与构建时间');
  assert.ok(auth.body.version.includes('.'), '认证后回完整版本号');
});

// ---- E1/E6：告警持续确认 + 恢复通知 + disk/temp ------------------------------

// ---- E1/E6：告警持续确认 + 恢复通知 + disk/temp ------------------------------

const CFG = { offlineSec: 120, cpuAlert: 90, memAlert: 90, diskAlert: 90, tempAlert: 80, cooldown: 1800 };

test('checkAgent：单样本 spike 不报；连续 N 个采样才报；恢复发一次并清状态（审查 E1）', async () => {
  const now = Date.now();
  const put = (id, ts, over) => db.insertMetric(id, {
    ts, cpu: over ? 95 : 10, mem_pct: 10, disk_pct: 10, temp: 40
  });

  // 场景 1：最近一条超限、前一条正常 → 不报（SUSTAIN_N 默认 2）
  const a1 = db.createAgent({ name: 'spike-node' });
  put(a1.id, now - 30000, false);
  put(a1.id, now - 15000, true);
  let r = await alerts.checkAgent({ id: a1.id, name: 'spike-node', last_seen: now }, now, CFG);
  assert.strictEqual(r.length, 0, '单样本 spike 不应触发');

  // 场景 2：连续 2 条超限 → 触发（无通知通道 → sendAlert 返回 false，
  // 但 job 已入队，长度可观测）
  const a2 = db.createAgent({ name: 'sustain-node' });
  put(a2.id, now - 30000, true);
  put(a2.id, now - 15000, true);
  r = await alerts.checkAgent({ id: a2.id, name: 'sustain-node', last_seen: now }, now, CFG);
  assert.strictEqual(r.length, 1, '连续 N 个采样超限应触发');

  // 场景 3：state 存在（曾告警）且持续低于阈值 → 发一次恢复并清状态
  const a3 = db.createAgent({ name: 'recover-node' });
  put(a3.id, now - 30000, false);
  put(a3.id, now - 15000, false);
  db.setAlertState(a3.id, 'cpu', now - 3600000);
  r = await alerts.checkAgent({ id: a3.id, name: 'recover-node', last_seen: now }, now, CFG);
  assert.strictEqual(r.length, 1, '恢复应发一次通知');
  assert.ok(!db.getAlertState(a3.id, 'cpu'), '恢复后应清除状态（不会重复发送）');
});

test('checkAgent：磁盘/温度超限同样按连续 N 采样触发（审查 E6）', async () => {
  const { id } = db.createAgent({ name: 'disk-temp-node' });
  const now = Date.now();
  for (const ts of [now - 30000, now - 15000]) {
    db.insertMetric(id, { ts, cpu: 10, mem_pct: 10, disk_pct: 95, temp: 85 });
  }
  const r = await alerts.checkAgent({ id, name: 'disk-temp-node', last_seen: now }, now, CFG);
  assert.strictEqual(r.length, 2, '磁盘 + 温度各触发一次');
});

// ---- E4：过期节点终态 ----------------------------------------------------------

test('checkExpiringAgents：已过期节点用独立终态 + 7 天冷却；临期仍 24h（审查 E4）', async () => {
  const now = Date.now();
  // 桩掉 https.request 让 Telegram 通道"发送成功"——否则 sendAlertGuarded 会因
  // 无可用通道回滚 state（D3 的失败回滚行为），无法观测冷却/终态语义。
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const realRequest = https.request;
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
  db.setConfig('notify_config', JSON.stringify({ telegram_bot_token: 'test-bot-token', telegram_chat_id: '123' }));
  try {
    const dstr = (offsetDays) => new Date(now + offsetDays * 86400000).toISOString().slice(0, 10);
    const { id: expiredId } = db.createAgent({ name: 'expired-node', expire_at: dstr(-10) });
    const { id: soonId } = db.createAgent({ name: 'soon-node', expire_at: dstr(3) });

    await alerts.checkExpiringAgents(now);
    assert.ok(db.getAlertState(expiredId, 'expired'), '已过期应写 expired 终态');
    assert.ok(!db.getAlertState(expiredId, 'expire'), '已过期不应写临期状态');
    assert.ok(db.getAlertState(soonId, 'expire'), '临期应写 expire 状态');

    // 7 天冷却内不重复发送（last_sent 不变）
    const before = db.getAlertState(expiredId, 'expired').last_sent;
    await alerts.checkExpiringAgents(now);
    assert.strictEqual(db.getAlertState(expiredId, 'expired').last_sent, before, '7 天冷却内不重复');
  } finally {
    https.request = realRequest;
    db.setConfig('notify_config', JSON.stringify({ smtp_user: '', smtp_pass: '', telegram_bot_token: '', telegram_chat_id: '' }));
  }
});

// ---- C5：静态资源流错误处理 ----------------------------------------------------

test('静态资源流读取失败时不挂起：返回 500（审查 C5）', async () => {
  const path = require('node:path');
  const { PassThrough } = require('node:stream');
  const THEMES_DIR = path.join(__dirname, '..', 'public', 'themes');
  const themesExisted = fs.existsSync(THEMES_DIR);
  const dir = path.join(THEMES_DIR, 'c5test');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'err.svg'), '<svg/>');
  const origCreate = fs.createReadStream;
  // 桩掉 createReadStream：返回一个 nextTick 即 emit error 的流，模拟
  // "existsSync 通过但读取失败"（竞态删除 / 权限不足）——与运行用户无关，
  // 不依赖 chmod 000（root 下不生效）
  fs.createReadStream = () => {
    const s = new PassThrough();
    process.nextTick(() => s.emit('error', new Error('simulated read failure')));
    return s;
  };
  try {
    const res = await request(app).get('/themes/c5test/err.svg');
    assert.strictEqual(res.status, 500, '流错误应返回 500 而非挂起');
  } finally {
    fs.createReadStream = origCreate;
    fs.rmSync(dir, { recursive: true, force: true });
    if (!themesExisted) { try { fs.rmdirSync(THEMES_DIR); } catch (_) {} }
  }
});

// ---- E5：月流量服务端积分交叉校验 ----------------------------------------------

test('trafficEstimateBucketed：按小时桶积分；>1h 的桶间隔不计（审查 E5）', () => {
  const { id } = db.createAgent({ name: 'traffic-node' });
  const H = 3600000;
  const base = Math.floor(Date.now() / H) * H; // 对齐绝对小时边界，桶归属确定
  const row = (ts, rx, tx) => db.insertMetric(id, { ts, cpu: 0, mem_pct: 0, net_rx_rate: rx, net_tx_rate: tx });
  row(base - 6 * H, 1000, 500); // 与下一桶隔 3h（>1h）→ 该间隔不计
  row(base - 3 * H, 1000, 500);
  row(base - 2 * H, 1000, 500);
  row(base - 1 * H, 1000, 500);
  const est = db.trafficEstimateBucketed(id, base - 7 * H);
  // 计入两个 1h 间隔：rx = 1000B/s × 3600s × 2 = 7.2MB；tx 减半
  assert.strictEqual(est.rx, 7200000);
  assert.strictEqual(est.tx, 3600000);
});
