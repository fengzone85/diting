'use strict';
// ============================================================
// 重聚合查询 worker（审查 C4）。
//
// 由 heavy-db.js 按需拉起；用独立只读连接在 worker 线程执行 heavy-queries.js
// 里的聚合 SQL，事件循环保持响应（/report、告警、其他请求不被阻塞）。
// 只读连接 + busy_timeout：与主线程写连接并发时短暂等待而非报错。
// 耗时超过 HEAVY_QUERY_BUDGET_MS 打 Warning（查询预算的可观测化——同步查询
// 无法真正中断，超预算即提示缩窗/加索引）。
// ============================================================
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const heavy = require('./heavy-queries');

let db = null;
try {
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
} catch (e) {
  // 只读打不开（如文件不存在/权限）：通知主线程回退，不拖垮进程
  parentPort.postMessage({ fatal: 'open failed: ' + e.message });
  process.exit(1);
}

const BUDGET_MS = Number(process.env.HEAVY_QUERY_BUDGET_MS || 10000);

parentPort.on('message', (msg) => {
  const { id, fn, args } = msg || {};
  const t0 = Date.now();
  try {
    if (typeof heavy[fn] !== 'function') throw new Error('unknown heavy fn: ' + fn);
    const rows = heavy[fn](db, ...(args || []));
    const ms = Date.now() - t0;
    if (ms > BUDGET_MS) {
      console.warn(`[dbworker] ${fn} 耗时 ${ms}ms 超过预算 ${BUDGET_MS}ms——考虑缩小时间窗或优化索引`);
    }
    parentPort.postMessage({ id, rows });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
