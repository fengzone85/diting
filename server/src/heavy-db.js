'use strict';
// ============================================================
// 重聚合查询的 worker 门面（审查 C4）。
//
// 用法：const rows = await heavyQuery('sparklinesAllSampled', sinceTs, maxPoints);
//
// 设计：
//   - 单 worker 串行执行（SQLite 单写者，聚合查询并发无收益，反而争锁）；
//   - worker 启动失败/崩溃/超时 → 自动回退主线程同步执行（db.heavyQuerySync），
//     行为与修复前一致，可用性优先；回退打 Warning 便于观测；
//   - HEAVY_QUERY_TIMEOUT_MS 超时的请求 reject 并由调用方回退（worker 中的
//     查询仍会跑完，结果丢弃——同步查询无法中断，此为已知限制）；
//   - stop() 供测试与优雅退出。
// ============================================================
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const db = require('./db');

const QUERY_TIMEOUT_MS = Number(process.env.HEAVY_QUERY_TIMEOUT_MS || 60000);
// 空闲回收：无进行中查询 N 毫秒后终止 worker（Node 的 worker.unref() 经验证
// 不足以释放进程存活权，只有 terminate 可以）。下次查询会自动重新拉起。
// 默认 5s：测试进程不必被悬挂线程拖住；生产低流量时也不空转一个线程。
const IDLE_TERMINATE_MS = Number(process.env.HEAVY_WORKER_IDLE_MS || 5000);

let worker = null;
let seq = 0;
let idleTimer = null;
const pending = new Map(); // id -> { resolve, reject, timer }

function armIdleTerminate() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0 && worker) {
      try { worker.terminate(); } catch (_) {}
      worker = null;
    }
  }, IDLE_TERMINATE_MS);
  idleTimer.unref?.();
}

function spawnWorker() {
  const w = new Worker(path.join(__dirname, 'dbworker.js'), { workerData: { dbPath: db.DB_PATH } });
  w.on('message', (msg) => {
    if (msg && msg.fatal) {
      console.warn('[heavy-db] worker 初始化失败，重查询回退主线程：', msg.fatal);
      failAll(new Error(msg.fatal));
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.rows);
    armIdleTerminate(); // 每次完成后重新武装空闲回收
  });
  w.on('error', (e) => {
    console.warn('[heavy-db] worker 错误，重查询回退主线程：', e.message);
    failAll(e);
  });
  w.on('exit', (code) => {
    if (code !== 0) failAll(new Error('worker exited with code ' + code));
    worker = null;
  });
  return w;
}

function failAll(err) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
  try { worker && worker.terminate(); } catch (_) {}
  worker = null;
}

async function heavyQuery(fn, ...args) {
  if (!worker) {
    try { worker = spawnWorker(); } catch (e) {
      console.warn('[heavy-db] worker 启动失败，重查询回退主线程：', e.message);
      worker = null;
    }
  }
  if (!worker) return db.heavyQuerySync(fn, args);

  const id = ++seq;
  try {
    const rows = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('heavy query timeout'));
      }, QUERY_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, fn, args });
    });
    return rows;
  } catch (e) {
    console.warn(`[heavy-db] ${fn} 未走 worker（${e.message}），回退主线程同步执行`);
    return db.heavyQuerySync(fn, args);
  }
}

function stop() {
  failAll(new Error('heavy-db stopped'));
}

module.exports = { heavyQuery, stop };
