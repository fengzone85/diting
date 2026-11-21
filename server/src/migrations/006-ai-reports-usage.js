'use strict';
// 006：ai_reports 追加 token 用量 / 耗时 / 降级标记列（老库 ADD COLUMN；列名硬编码常量）。
const { addColumnsIfMissing } = require('./util');

const COLS = [
  ['prompt_tokens', 'INTEGER DEFAULT 0'],
  ['completion_tokens', 'INTEGER DEFAULT 0'],
  ['total_tokens', 'INTEGER DEFAULT 0'],
  ['duration_ms', 'INTEGER DEFAULT 0'],
  ['degraded', 'INTEGER DEFAULT 0'],
];

module.exports = {
  version: 6,
  name: 'ai-reports-usage',
  up(db) {
    addColumnsIfMissing(db, 'ai_reports', COLS);
  },
};
