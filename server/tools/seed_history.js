// 给所有 mock- 开头的 agent 批量灌历史 metrics（模拟 30s 间隔真实上报）
// 用法: node tools/seed_history.js <days> <intervalSec>
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || '/data/simple-probe-data/server-data/monitor.db';
const Database = require('better-sqlite3');
const dbApi = require('../src/db.js');

const DAYS = parseInt(process.argv[2] || '30', 10);
const INTERVAL = parseInt(process.argv[3] || '30', 10);

const dbFile = process.env.DB_PATH;
const db = new Database(dbFile);
// 保持与主进程一致的 rollback journal 模式，避免 WAL 切换导致主进程读不一致

const agents = dbApi.getAgents().filter(a => (a.name || '').startsWith('mock-'));
console.log(`seeding ${agents.length} mock agents, ${DAYS}d @ ${INTERVAL}s`);

const insert = db.prepare(`INSERT INTO metrics
  (agent_id, ts, cpu, mem_used, mem_total, mem_pct, disk_used, disk_total, disk_pct,
   load1, load5, load15, net_rx_rate, net_tx_rate, net_rx_month, net_tx_month, uptime,
   temp, swap_used, swap_total, swap_pct, disk_r_rate, disk_w_rate, probes, disks)
  VALUES (@agent_id, @ts, @cpu, @mem_used, @mem_total, @mem_pct, @disk_used, @disk_total, @disk_pct,
   @load1, @load5, @load15, @net_rx_rate, @net_tx_rate, @net_rx_month, @net_tx_month, @uptime,
   @temp, @swap_used, @swap_total, @swap_pct, @disk_r_rate, @disk_w_rate, @probes, @disks)`);

const now = Date.now();
const start = now - DAYS * 86400000;
const PROBES = { '移动': 12, '电信': 26, '联通': 25, '公共': 200 };
const rnd = (a, b) => a + Math.random() * (b - a);

const tx = db.transaction((rows) => { for (const r of rows) insert.run(r); });

let total = 0;
const t0 = Date.now();
for (const a of agents) {
  let batch = [];
  for (let ts = start; ts <= now; ts += INTERVAL * 1000) {
    const probes = {};
    for (const [k, base] of Object.entries(PROBES)) {
      const ms = Math.max(1, Math.round(base + (Math.random() - 0.5) * base * 0.5));
      probes[k] = { ms, ok: true, loss: 0 };
    }
    batch.push({
      agent_id: a.id, ts,
      cpu: +rnd(5, 60).toFixed(1),
      mem_used: Math.round(rnd(1, 4) * 1073741824), mem_total: 8589934592, mem_pct: +rnd(20, 70).toFixed(1),
      disk_used: Math.round(rnd(20, 80) * 1073741824), disk_total: 107374182400, disk_pct: +rnd(20, 80).toFixed(1),
      load1: +rnd(0.1, 2).toFixed(2), load5: +rnd(0.1, 1.5).toFixed(2), load15: +rnd(0.1, 1).toFixed(2),
      net_rx_rate: Math.round(rnd(1, 50) * 1048576), net_tx_rate: Math.round(rnd(1, 20) * 1048576),
      net_rx_month: Math.round(rnd(1, 100) * 1073741824), net_tx_month: Math.round(rnd(1, 50) * 1073741824),
      uptime: Math.round(rnd(3600, 86400 * 30)), temp: Math.round(rnd(40, 65)),
      swap_used: 0, swap_total: 4294967296, swap_pct: 0,
      disk_r_rate: Math.round(rnd(0, 10) * 1048576), disk_w_rate: Math.round(rnd(0, 10) * 1048576),
      probes: JSON.stringify(probes),
      disks: JSON.stringify([{ mount: '/', used: 53687091200, total: 107374182400, pct: 50 }])
    });
    if (batch.length >= 1000) { tx(batch); total += batch.length; batch = []; }
  }
  if (batch.length) { tx(batch); total += batch.length; }
}
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`done: inserted ${total} rows in ${dt}s (${(total / parseFloat(dt)).toFixed(0)} rows/s)`);
db.close();
