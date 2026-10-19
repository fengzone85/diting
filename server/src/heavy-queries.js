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
// 改 SQL 只需改这一处，两条路径自动一致（避免语义分叉）。
// ============================================================

// 负载曲线列集（不含 probes / disks 大字段）。db.js 与本文件共用同一份定义，
// 避免两处列清单漂移导致主线程与 worker 返回结构不一致。
const LOAD_COLS = `ts, agent_id, cpu, mem_used, mem_total, mem_pct, load1, load5, load15,
  net_rx_rate, net_tx_rate, net_rx_month, net_tx_month, disk_used, disk_total,
  disk_r_rate, disk_w_rate, swap_used, swap_total, swap_pct, temp, process_count`;

// 单节点负载曲线采样（保留首尾点）：窗口函数按 ts 编号均匀抽样。
const loadOne = (db, agentId, sinceTs, maxPoints) => {
  const step = Math.max(1, Math.floor(Number(maxPoints) || 1));
  return db.prepare(`
    WITH numbered AS (
      SELECT ${LOAD_COLS},
             ROW_NUMBER() OVER (ORDER BY ts ASC) AS rn,
             COUNT(*) OVER () AS cnt
      FROM metrics WHERE agent_id=@agentId AND ts>=@since
    )
    SELECT ${LOAD_COLS} FROM numbered
    WHERE rn = 1 OR rn = cnt OR rn % MAX(1, CAST(cnt/CAST(@step AS INTEGER) AS INTEGER)) = 0
    ORDER BY ts ASC`).all({ agentId, since: sinceTs, step });
};

// 跨节点负载曲线采样：按「时间桶 + 桶内最早一行」（不用窗口函数，实测 720h
// 全库 23.6s → 2.2s），保留首尾桶语义。
const loadAll = (db, sinceTs, maxPoints) => {
  const bucket = Math.max(1, Math.floor((Date.now() - sinceTs) / Math.max(1, Number(maxPoints) || 1)));
  return db.prepare(`
    SELECT ${LOAD_COLS.replace(/\b(ts|agent_id)\b/g, 'm.$1')} FROM metrics m
    JOIN (
      SELECT agent_id, MIN(ts) AS ts
      FROM metrics WHERE ts>=@since
      GROUP BY agent_id, CAST((ts - @since) / CAST(@bucket AS INTEGER) AS INTEGER)
    ) k ON m.agent_id = k.agent_id AND m.ts = k.ts
    ORDER BY m.agent_id, m.ts ASC`).all({ since: sinceTs, bucket });
};

// 全量 sparklines 采样：窗口函数按 agent 分组，每 agent 最多 maxPoints 点。
const sparklinesAllSampled = (db, sinceTs, maxPoints, untilTs) => {
  const step = Math.max(1, Math.floor(Number(maxPoints) || 1));
  return db.prepare(`
    WITH numbered AS (
      SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate,
             net_rx_month, net_tx_month,
             load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total,
             process_count,
             ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ts ASC) AS rn,
             COUNT(*) OVER (PARTITION BY agent_id) AS cnt
      FROM metrics WHERE ts>=@since AND (@until IS NULL OR ts<@until)
    )
    SELECT ts, agent_id, cpu, mem_pct, disk_pct, net_rx_rate, net_tx_rate,
           net_rx_month, net_tx_month,
           load1, temp, swap_pct, uptime, disk_r_rate, disk_w_rate, disk_used, disk_total,
           process_count
    FROM numbered
    WHERE rn = 1 OR rn = cnt OR rn % MAX(1, CAST(cnt/CAST(@step AS INTEGER) AS INTEGER)) = 0
    ORDER BY agent_id, ts ASC`).all({ since: sinceTs, step, until: untilTs == null ? null : Number(untilTs) });
};

// 集群级时间桶聚合（仪表盘平均 CPU/内存趋势）：跨 agent 按桶求均值。
const clusterAvg = (db, sinceTs, spanMs, maxPoints) => {
  const bucket = Math.max(1, Math.ceil(spanMs / Math.max(1, maxPoints)));
  return db.prepare(`
    WITH agg AS (
      SELECT CAST((ts - @since) / @bucket AS INTEGER) AS b,
             AVG(cpu) AS cpu, AVG(mem_pct) AS mem_pct
      FROM metrics WHERE ts>=@since AND cpu IS NOT NULL
      GROUP BY b
    )
    SELECT (@since + CAST(b AS INTEGER) * @bucket) AS ts, cpu, mem_pct
    FROM agg ORDER BY b ASC`).all({ since: sinceTs, bucket });
};

// 磁盘趋势：跨 agent 按时间桶取 disk_pct 均值。必须输出 MIN(ts) AS ts——
// 调用方用首末 ts 求跨度，只返回桶号会得到 NaN 使趋势分析静默失效。
const diskTrendAll = (db, sinceTs, bucketMs) => db.prepare(`
  SELECT agent_id,
         MIN(ts) AS ts,
         AVG(disk_pct) AS pct
  FROM metrics
  WHERE ts >= @since AND disk_pct IS NOT NULL
  GROUP BY agent_id, CAST((ts - @since) / CAST(@bucket AS INTEGER) AS INTEGER)
  ORDER BY agent_id, ts`).all({ since: sinceTs, bucket: Math.max(1, bucketMs) });

// 探针（ping）历史：只取 ts+agent_id+probes 三列，按 agent 时间桶降采样，
// 规避 SELECT * 全表物化（720h 数百万行）导致 OOM。
const probesAll = (db, sinceTs, maxPoints) => {
  const bucket = Math.max(1, Math.floor((Date.now() - sinceTs) / Math.max(1, Number(maxPoints) || 1)));
  return db.prepare(`
    SELECT m.ts, m.agent_id, m.probes FROM metrics m
    JOIN (
      SELECT agent_id, MIN(ts) AS ts
      FROM metrics WHERE ts>=@since AND probes IS NOT NULL
      GROUP BY agent_id, CAST((ts - @since) / CAST(@bucket AS INTEGER) AS INTEGER)
    ) k ON m.agent_id = k.agent_id AND m.ts = k.ts
    ORDER BY m.agent_id, m.ts ASC`).all({ since: sinceTs, bucket });
};

module.exports = {
  LOAD_COLS, loadOne, loadAll, sparklinesAllSampled, clusterAvg, diskTrendAll, probesAll
};
