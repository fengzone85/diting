'use strict';
// 复现 BUG-2：刚创建、从未上报过的节点，第一轮告警检查就被判「离线」并发送通知。
//
// 运行：REPO=/path/to/diting node repro/never-reported-alert.js
// 判定：修复前打印一条 offline 告警调用；修复后调用列表为空。
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'repro-admin-token-0123456789';
process.env.DB_PATH = '/tmp/diting-repro-alert.db';
process.env.OFFLINE_THRESHOLD_SEC = '60';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(process.env.REPO || path.join(__dirname, '../../diting-gh'));
const request = require(path.join(ROOT, 'server/node_modules/supertest'));
for (const s of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }

const { app, server } = require(path.join(ROOT, 'server/server.js'));
const db = require(path.join(ROOT, 'server/src/db'));
const alerts = require(path.join(ROOT, 'server/src/alerts'));
const notify = require(path.join(ROOT, 'server/src/notify'));
const H = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };

const calls = [];
notify.sendEvent = async (event, payload) => { calls.push({ event, subject: payload.subject }); return true; };

(async () => {
  const st = await request(app).get('/api/settings').set(H);
  const ui = st.body.ui; ui.agent_server_url = 'http://127.0.0.1:8081';
  await request(app).put('/api/settings').set(H).send({ ui });

  const created = await request(app).post('/api/agents').set(H).send({ name: 'brand-new-node' });
  const a = db.getAgent(created.body.id);
  console.log('新建节点 last_seen =', a.last_seen, '（0 表示 agent 尚未安装/首次上报）');
  await alerts.checkAgent(a, Date.now());
  console.log('首次检查触发的通知:', JSON.stringify(calls));

  alerts.stop();
  try { server.closeAllConnections?.(); } catch {}
  await new Promise((r) => server.close(r));
  for (const s of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
