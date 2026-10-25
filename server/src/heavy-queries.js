'use strict';
// ============================================================
// 重聚合查询（审查 C4）：跨全表/全节点的聚合 SQL，与 db 句柄解耦。
//
// 为什么单独抽模块：better-sqlite3 是同步 API，这些查询在 720h 窗口下要跑
// 数秒（注释实测：全库窗口函数版 23.6s、分桶版 2.2s），直接在主线程执行会
// 阻塞事件循环——期间 /report、告警、全部请求挂起（可用性故障，且公开端点
// 未认证即可触发）。本模块把 SQL 与连接解耦（首个参数是 db 句柄），于是：
//   - 主线程：db.js 委派到这里（行为不变，作为 worker 不可用时的回退路径）；
//   - worker thread（dbworker.js）：用独立只读连接执行，事件循环保持响应。
//
// S2：SQL 本体已改为 metrics-merge.js 的「小时行 + 明细行加权合并」，
// 本文件只保留对外签名，保证 worker / 主线程两条路径共用同一份口径。
// ============================================================

const merge = require('./metrics-merge');

// 负载曲线列集（不含 probes / disks 大字段）。db.js 与本文件共用同一份定义，
// 避免两处列清单漂移导致主线程与 worker 返回结构不一致。
const LOAD_COLS = `ts, agent_id, cpu, mem_used, mem_total, mem_pct, load1, load5, load15,
  net_rx_rate, net_tx_rate, net_rx_month, net_tx_month, disk_used, disk_total,
  disk_r_rate, disk_w_rate, swap_used, swap_total, swap_pct, temp, process_count`;

// 单节点负载曲线（保留首末点明细精度）
const loadOne = (db, agentId, sinceTs, maxPoints, untilTs) =>
  merge.loadOne(db, agentId, sinceTs, maxPoints, untilTs);

// 跨节点负载曲线（每 agent 一个序列）
const loadAll = (db, sinceTs, maxPoints, untilTs) =>
  merge.loadAll(db, sinceTs, maxPoints, untilTs);

// 全量 sparklines（按 agent 分组，桶宽由窗口/maxPoints 反推）
const sparklinesAllSampled = (db, sinceTs, maxPoints, untilTs) =>
  merge.sparklinesAll(db, sinceTs, maxPoints, untilTs);

// 集群级时间桶聚合（仪表盘平均 CPU/内存趋势）
const clusterAvg = (db, sinceTs, spanMs, maxPoints) =>
  merge.clusterAvg(db, sinceTs, spanMs, maxPoints);

// 磁盘趋势（AI 日报 14 天窗口依赖）
const diskTrendAll = (db, sinceTs, bucketMs) =>
  merge.diskTrendAll(db, sinceTs, bucketMs);

// 探针（ping）历史：小时折叠层与明细层加权合并
const probesAll = (db, sinceTs, maxPoints) =>
  merge.probesAll(db, sinceTs, maxPoints);

// 单节点探针历史（F4 可用率聚合端点用）。
// 为什么单独提供：公开端点 /public/agents/:id/probes 走的是**单节点**窗口，
// 30d 窗口下 SQL 采样 + JSON.parse 仍会占用主线程数百毫秒；
// 放进 worker 后主线程只做聚合，事件循环不再被拖住。
const probesOne = (db, agentId, sinceTs, maxPoints) =>
  merge.probesOne(db, agentId, sinceTs, maxPoints);

module.exports = {
  LOAD_COLS, loadOne, loadAll, sparklinesAllSampled, clusterAvg, diskTrendAll, probesAll, probesOne
};
