'use strict';
// 002：metrics 追加列（老库补列；新库由 001 建表后再补到这里）。
// 补列在迁移事务内执行，失败整体回滚；列清单由 metric-schema.js 派生，不在此重复维护。
const { addColumnsIfMissing } = require('./util');
const { APPEND_COLUMNS } = require('../metric-schema');

// 追加列清单由 metric-schema.js 生成（baseline:false 的列）：与建表/查询共用同一份定义，
// 避免「schema 加了列、迁移漏加」导致老库启动后 no such column。
const COLS = APPEND_COLUMNS;

module.exports = {
  version: 2,
  name: 'metrics-columns',
  up(db) {
    addColumnsIfMissing(db, 'metrics', COLS);
  },
};
