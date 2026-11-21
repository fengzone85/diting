'use strict';
// 005：traffic_state 追加接口集指纹列（S1）。
// 必须同时进 upsertTrafficState 的列清单：INSERT OR REPLACE 未列出的列会取默认值，
// 漏掉会让每次 flush 后 epoch 丢失 → 下轮又触发一次基线对齐。
const { addColumnsIfMissing } = require('./util');

const COLS = [
  ['epoch', "TEXT DEFAULT ''"],
];

module.exports = {
  version: 5,
  name: 'traffic-state-epoch',
  up(db) {
    addColumnsIfMissing(db, 'traffic_state', COLS);
  },
};
