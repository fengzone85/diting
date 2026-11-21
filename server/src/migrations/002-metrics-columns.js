'use strict';
// 002：metrics 追加列（老库补列；新库由 001 建表后再补到这里）。
// 列名与类型硬编码常量；补列在迁移事务内执行，失败整体回滚。
const { addColumnsIfMissing } = require('./util');

const COLS = [
  ['temp', 'REAL'],
  ['swap_used', 'INTEGER'],
  ['swap_total', 'INTEGER'],
  ['swap_pct', 'REAL'],
  ['probes', 'TEXT'],
  ['disk_r_rate', 'REAL'],
  ['disk_w_rate', 'REAL'],
  ['disks', 'TEXT'],
  // 进程总数（聚合计数，非指纹；0 = 未采集/老 agent 不带该字段）
  ['process_count', 'INTEGER DEFAULT 0'],
  // 审查 C-1/E2：受控端上报的实际上报间隔（秒），0 = 未上报/老 agent
  ['interval', 'INTEGER DEFAULT 0'],
];

module.exports = {
  version: 2,
  name: 'metrics-columns',
  up(db) {
    addColumnsIfMissing(db, 'metrics', COLS);
  },
};
