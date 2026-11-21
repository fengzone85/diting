'use strict';
// 004：sessions 追加到期与「受信任设备」列（老库 ADD COLUMN；列名硬编码常量）。
// expires_at NULL = 旧口径会话（prune 仍按 last_seen + 旧 TTL 规则），保证存量行为不变。
const { addColumnsIfMissing } = require('./util');

const COLS = [
  ['expires_at', 'INTEGER'],
  ['remember', 'INTEGER NOT NULL DEFAULT 0'],
];

module.exports = {
  version: 4,
  name: 'sessions-columns',
  up(db) {
    addColumnsIfMissing(db, 'sessions', COLS);
  },
};
