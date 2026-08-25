// 批量注册 mock agent 到 DB，导出 {id, token} 供 N5100 reporter 使用
// 用法: node tools/register_mock_agents.js <count> <outfile>
const path = require('path');
const fs = require('fs');
// 必须与服务端使用同一个 DB 文件（服务端由 .env 指定 DB_PATH）
process.env.DB_PATH = process.env.DB_PATH || '/data/simple-probe-data/server-data/monitor.db';
const db = require('../src/db.js');

const count = parseInt(process.argv[2] || '60', 10);
const outfile = process.argv[3] || path.join(__dirname, 'mock_agents.json');

const created = [];
for (let i = 0; i < count; i++) {
  const a = db.createAgent({
    name: `mock-${String(i).padStart(3, '0')}`,
    merchant: 'mock',
    grp: 'mock',
    country: 'CN',
    probe_targets: JSON.stringify(['移动', '电信', '联通', '公共']),
  });
  created.push({ id: a.id, token: a.token });
}
fs.writeFileSync(outfile, JSON.stringify(created, null, 2));
console.log(`registered ${created.length} agents -> ${outfile}`);
console.log('sample:', JSON.stringify(created[0]));
