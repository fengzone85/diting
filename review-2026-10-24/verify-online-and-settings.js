'use strict';
// 合并修复的验收脚本（三方对比：base / 对方补丁 / 对方补丁+本次增补）。
// 覆盖对方 BUG-1/2/3 之外的三处漏修或回归：
//   A) /metrics 是第 6 个在线判定入口（对方 BUG-1 只列了 5 个）
//   B) 局部 PUT /api/settings 不得清空其它键、也不得把默认值固化进库
//      （固化会让 RETENTION_DAYS / ALERT_* 环境变量失效，prune 按 30 天删历史）
//   C) map 型配置（custom_tags）必须能清空
//   D) AI 摘要的 offlineSec 必须跟随「节点 > 分组 > 全局」
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'verifym-admin-token-0123456789';
process.env.DB_PATH = '/tmp/diting-verify-merged.db';
process.env.OFFLINE_THRESHOLD_SEC = '60';
process.env.RETENTION_DAYS = '90';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(process.env.REPO);
const request = require(path.join(ROOT, 'server/node_modules/supertest'));
for (const s of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }

const { app, server } = require(path.join(ROOT, 'server/server.js'));
const db = require(path.join(ROOT, 'server/src/db'));
const alerts = require(path.join(ROOT, 'server/src/alerts'));
const H = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };

const line = (k, v) => console.log(`  ${k.padEnd(28)} ${v}`);
const rawUi = () => { try { return JSON.parse(db.getConfig('ui_settings') || '{}'); } catch { return {}; } };

(async () => {
  // 最小落库状态：只显式设过服务端地址（模拟脚本/第三方只写了一个字段的部署）
  db.setUiSettings({ agent_server_url: 'http://127.0.0.1:8081' });
  const created = await request(app).post('/api/agents').set(H).send({ name: 'verify-node' });
  const id = created.body.id;
  await request(app).post('/api/report')
    .set({ 'X-Agent-ID': id, Authorization: `Bearer ${created.body.token}` })
    .send({ cpu: 1, mem_total: 1024, mem_used: 100, net_rx: 0, net_tx: 0, ts: Date.now() });

  console.log('[B] 局部 PUT {ui:{alert:{offline_sec:45}}} 的落库结果');
  const beforeKeys = Object.keys(rawUi()).sort();
  await request(app).put('/api/settings').set(H).send({ ui: { alert: { offline_sec: 45 } } });
  const after = rawUi();
  const afterKeys = Object.keys(after).sort();
  const lost = beforeKeys.filter((k) => !afterKeys.includes(k));
  const added = afterKeys.filter((k) => !beforeKeys.includes(k));
  line('落库键数 前→后', `${beforeKeys.length} → ${afterKeys.length}`);
  line('被丢掉的键', lost.join(',') || '（无）');
  line('新增的键', added.length ? added.join(',') : '（无）');
  line('agent_server_url 保留', after.agent_server_url || '(丢失)');
  line('retention_days 落库', after.retention_days === undefined ? '(未固化)' : after.retention_days);
  line('getRetentionDays() env=90 →', db.getRetentionDays());
  const unrelated = added.filter((k) => k !== 'alert');
  line('判定', lost.length ? 'FAIL 键被清空（全量覆盖）'
    : (unrelated.length || after.retention_days !== undefined)
      ? 'FAIL 默认值被固化进库（env 被覆盖，prune 将按 30 天删数据）'
      : 'PASS 只改目标字段(alert)、不丢键、不固化默认值');

  console.log('[A] /metrics 入口（env=60s / UI=10s / 20s 未上报）');
  await request(app).put('/api/settings').set(H).send({ ui: { alert: { offline_sec: 10 } } });
  db.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(Date.now() - 20000, id);
  const m = await request(app).get('/metrics').set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
  const upLine = String(m.text).split('\n').find((l) => l.startsWith('monitor_up{'));
  line('monitor_up 行', upLine);
  line('判定', upLine && upLine.endsWith(' 0') ? 'PASS 与看板一致（离线）' : 'FAIL 与看板分裂（在线）');

  console.log('[C] map 型配置清空语义');
  await request(app).put('/api/settings').set(H).send({ ui: { custom_tags: { a: 'x', b: 'y' } } });
  await request(app).put('/api/settings').set(H).send({ ui: { custom_tags: {} } });
  const tags = rawUi().custom_tags || {};
  line('清空后 custom_tags', JSON.stringify(tags));
  line('判定', Object.keys(tags).length === 0 ? 'PASS 可清空' : 'FAIL 旧值复活（幽灵配置）');

  console.log('[D] AI 摘要 offlineSec 是否跟随节点覆盖（节点覆盖 10s）');
  db.upsertAlertOverride(id, { offline_sec: 10 });
  const summarizer = require(path.join(ROOT, 'server/src/ai/summarizer'));
  const sum = summarizer.summarize({ periodHours: 1 });
  const nodeRow = (sum.agents || []).find((a) => a.id === id || a.name === 'verify-node');
  line('全局 thresholds.offline_sec', sum.thresholds && sum.thresholds.offline_sec);
  line('该节点摘要 online', nodeRow && nodeRow.online);
  line('判定', nodeRow && nodeRow.online === false
    ? 'PASS 按节点覆盖判离线，与告警同源'
    : 'FAIL 仍按全局判在线，日报与告警打架');

  alerts.stop();
  try { server.closeAllConnections?.(); } catch {}
  await new Promise((r) => server.close(r));
  for (const s of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
