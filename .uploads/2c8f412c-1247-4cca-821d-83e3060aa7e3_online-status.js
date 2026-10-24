'use strict';
// 复现 BUG-1：同一条「20 秒未上报」的节点，在不同接口得到相反的在线状态。
//
// 前置：REPO 指向 diting 源码根目录，且已 npm ci --include=dev（需要 supertest）。
// 运行：REPO=/path/to/diting node repro/online-status.js
//
// 判定：修复前 /api/agents 为 false，其余接口为 true；修复后全部 false。
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'repro-admin-token-0123456789';
process.env.DB_PATH = '/tmp/diting-repro-online.db';
process.env.OFFLINE_THRESHOLD_SEC = '60';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(process.env.REPO || path.join(__dirname, '../../diting-gh'));
const request = require(path.join(ROOT, 'server/node_modules/supertest'));
const dbFile = process.env.DB_PATH;
for (const s of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + s); } catch {} }

const { app, server } = require(path.join(ROOT, 'server/server.js'));
const db = require(path.join(ROOT, 'server/src/db'));
const alerts = require(path.join(ROOT, 'server/src/alerts'));
const H = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };

(async () => {
  // 配置服务端地址（否则创建节点返回 400 server_url_not_configured）
  const st0 = await request(app).get('/api/settings').set(H);
  const ui0 = st0.body.ui; ui0.agent_server_url = 'http://127.0.0.1:8081';
  await request(app).put('/api/settings').set(H).send({ ui: ui0 });

  const created = await request(app).post('/api/agents').set(H).send({ name: 'repro-node' });
  const id = created.body.id;
  await request(app).post('/api/report')
    .set({ 'X-Agent-ID': id, Authorization: `Bearer ${created.body.token}` })
    .send({ cpu: 1, mem_total: 1024, mem_used: 100, net_rx: 0, net_tx: 0, ts: Date.now() });

  // UI 阈值 10s，环境变量仍是 60s
  const st = await request(app).get('/api/settings').set(H);
  const ui = st.body.ui; ui.alert = Object.assign({}, ui.alert, { offline_sec: 10 });
  await request(app).put('/api/settings').set(H).send({ ui });

  // last_seen 拨回 20s 前：10 < 20 < 60，两个判定源必然分歧
  db.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(Date.now() - 20000, id);

  const show = async (p) => {
    const r = await request(app).get(p).set(H);
    const b = r.body;
    const pick = Array.isArray(b)
      ? (b.find((x) => x.id === id) || b[0])
      : (Array.isArray(b && b.data) ? b.data[0] : (b.agent || b.node || b));
    return `${String(p).padEnd(24)} status=${r.status} online=${pick && pick.online}`;
  };
  console.log('UI offline_sec=10 / env OFFLINE_THRESHOLD_SEC=60 / last_seen=now-20s');
  for (const p of ['/api/agents', `/api/agents/${id}`, '/api/overview', '/api/v1/nodes', '/api/public/agents']) {
    console.log(' ', await show(p));
  }

  alerts.stop();
  try { server.closeAllConnections?.(); } catch {}
  await new Promise((r) => server.close(r));
  for (const s of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + s); } catch {} }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
