'use strict';
// report.js 后处理与渲染单测（**零 DB 依赖**：只 require report.js，其依赖的 db 模块
// 在 require 时才会打开数据库，故这里先指向内存库以免碰到真实数据）
//
// 重点：capHighlights 的职责边界——prompt 只约束条数/排序，聚合 100% 由后处理生成；
// 幻觉节点名必须被丢弃；裁剪结果要回写 analysis（否则 report_json 仍是几十 KB 的节点清单）。
//
// 运行：cd server && /usr/bin/node --test src/ai/report.test.js

process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const { test } = require('node:test');
const assert = require('node:assert');
const { capHighlights, renderStatsText } = require('./report');

// 构造 summary：online 节点若干 + offline 节点若干
function mkSummary(onlineNames, offlineNames) {
  return {
    period: '24h',
    agent_count: onlineNames.length + offlineNames.length,
    online_count: onlineNames.length,
    offline_count: offlineNames.length,
    agents: [
      ...onlineNames.map((n) => ({ name: n, online: true })),
      ...offlineNames.map((n) => ({ name: n, online: false }))
    ]
  };
}

test('capHighlights: 大量离线节点被聚合成一条，输出 ≤9 条', () => {
  const offline = Array.from({ length: 62 }, (_, i) => `mock-${String(i).padStart(3, '0')}`);
  const analysis = {
    risk_level: 'high',
    summary: '整体可用性低',
    highlights: offline.map((n) => ({ agent_name: n, issue: '节点离线', reason: 'r', suggestion: 's' }))
  };
  const r = capHighlights(analysis, mkSummary(['j4125'], offline));
  assert.ok(r.analysis.highlights.length <= 9, `应 ≤9 条，实际 ${r.analysis.highlights.length}`);
  assert.strictEqual(r.analysis.highlights[0].agent_name, '(多节点)');
  assert.match(r.analysis.highlights[0].issue, /62 台节点离线/);
  assert.strictEqual(r.stats.raw, 62);
  assert.strictEqual(r.stats.dropped_unknown, 0);
});

test('capHighlights: 模型自行聚合的条目被丢弃后，离线仍必须出现聚合条目（真机报告 #54 回归）', () => {
  // 真实形态：模型把 61 台离线写成 "mock-000 ~ mock-059 等 61 台节点"（非真实节点名），
  // 同时给了 3 条在线节点 j4125 的问题。修复前：该条被丢 → 无离线聚合 → 离线信息消失。
  const offline = Array.from({ length: 61 }, (_, i) => `mock-${String(i).padStart(3, '0')}`);
  const analysis = {
    highlights: [
      { agent_name: 'mock-000 ~ mock-059 等 61 台节点', issue: '大量节点离线', reason: 'r', suggestion: 's' },
      { agent_name: 'j4125', issue: '磁盘增长', reason: 'r', suggestion: 's' },
      { agent_name: 'j4125', issue: '账号过期', reason: 'r', suggestion: 's' }
    ]
  };
  const r = capHighlights(analysis, mkSummary(['j4125'], offline));
  assert.strictEqual(r.stats.dropped_unknown, 1);
  assert.strictEqual(r.analysis.highlights[0].agent_name, '(多节点)');
  assert.match(r.analysis.highlights[0].issue, /61 台节点离线/);
});

test('capHighlights: 沉默期（stale）节点不逐台展开，只在离线聚合里计数', () => {
  const offline = Array.from({ length: 5 }, (_, i) => `old-${i}`);
  const analysis = {
    highlights: [
      ...offline.map((n) => ({ agent_name: n, issue: '节点离线', reason: '', suggestion: '' })),
      { agent_name: 'j4125', issue: 'CPU 高', reason: '', suggestion: '' }
    ]
  };
  const summary = mkSummary(['j4125'], offline);
  summary.silent_days = 3;
  summary.agents.forEach((a) => { if (!a.online) a.stale = true; });
  const r = capHighlights(analysis, summary);
  assert.strictEqual(r.stats.stale_dropped, 5);
  assert.strictEqual(r.stats.kept, 2, '聚合条目 + 在线节点条目');
  assert.match(r.analysis.highlights[0].issue, /其中 5 台超过 3 天未上报/);
  assert.ok(r.analysis.highlights.every((h) => !offline.includes(h.agent_name)), 'stale 节点不应逐台出现');
});

test('capHighlights: 不在摘要中的节点名（幻觉）被丢弃并计数', () => {
  const analysis = {
    highlights: [
      { agent_name: 'j4125', issue: 'CPU 高', reason: 'r', suggestion: 's' },
      { agent_name: '不存在的主机', issue: '磁盘满', reason: 'r', suggestion: 's' }
    ]
  };
  const r = capHighlights(analysis, mkSummary(['j4125'], []));
  assert.strictEqual(r.analysis.highlights.length, 1);
  assert.strictEqual(r.stats.dropped_unknown, 1);
});

test('capHighlights: 少量条目不裁剪、不改写', () => {
  const analysis = {
    highlights: [
      { agent_name: 'a', issue: 'i1', reason: 'r1', suggestion: 's1' },
      { agent_name: 'b', issue: 'i2', reason: 'r2', suggestion: 's2' }
    ]
  };
  const r = capHighlights(analysis, mkSummary(['a', 'b'], []));
  assert.deepStrictEqual(r.analysis.highlights.map((h) => h.agent_name), ['a', 'b']);
  assert.strictEqual(r.stats.kept, 2);
});

test('capHighlights: 超过上限时补一条汇总', () => {
  const names = Array.from({ length: 20 }, (_, i) => `n${i}`);
  const analysis = { highlights: names.map((n) => ({ agent_name: n, issue: 'x', reason: '', suggestion: '' })) };
  const r = capHighlights(analysis, mkSummary(names, []), { max: 8 });
  assert.strictEqual(r.analysis.highlights.length, 9);              // 8 条 + 汇总
  assert.strictEqual(r.analysis.highlights[8].agent_name, '(其他)');
});

test('capHighlights: 非对象/数组入参原样透传（不做假设）', () => {
  assert.deepStrictEqual(capHighlights(null, mkSummary([], [])), { analysis: null, stats: null });
  const arr = [1, 2, 3];
  assert.strictEqual(capHighlights(arr, mkSummary([], [])).analysis, arr);
});

test('capHighlights: 非字符串字段被安全转换并截断', () => {
  const analysis = { highlights: [{ agent_name: 'a', issue: { a: 1 }, reason: 12345, suggestion: 'x'.repeat(500) }] };
  const r = capHighlights(analysis, mkSummary(['a'], []));
  const h = r.analysis.highlights[0];
  assert.strictEqual(h.issue, '[object Object]');
  assert.strictEqual(h.reason, '12345');
  assert.strictEqual(h.suggestion.length, 300);
});

test('renderStatsText: 无异常节点时给出一句话结论（中英）', () => {
  const summary = mkSummary(['j4125'], []);
  summary.agents[0].cpu = { avg: 10, max: 20, over_threshold_minutes: 0 };
  summary.agents[0].memory = { avg: 30, max: 40, slope_pct: 0 };
  summary.agents[0].disk = { current_pct: 50, estimated_full_days: null, trend_note: 'no_growth', trend_window_days: 7 };
  summary.agents[0].billing = { billing_cycle: 30, days_until_expire: 20 };
  assert.match(renderStatsText(summary, 'zh-CN'), /所有节点指标正常/);
  assert.match(renderStatsText(summary, 'en'), /All agents normal/);
});

test('renderStatsText: 磁盘行带窗口/区间/置信度，缺数据时明确说明', () => {
  const mk = (disk) => {
    const s = mkSummary(['j4125'], []);
    s.agents[0].cpu = { avg: 95, max: 99, over_threshold_minutes: 30 };
    s.agents[0].memory = { avg: 30, max: 40, slope_pct: 0 };
    s.agents[0].disk = disk;
    s.agents[0].billing = { billing_cycle: 30, days_until_expire: 20 };
    return s;
  };
  const withRange = renderStatsText(mk({
    current_pct: 75.3, estimated_full_days: 6, estimated_full_days_range: [4, 21],
    trend_confidence: 'low', trend_window_days: 7, trend_note: 'ok'
  }), 'zh-CN');
  assert.match(withRange, /按近 7 天趋势约 6 天达 90%（4–21 天，置信度低）/);
  assert.doesNotMatch(withRange, /按当前增速/);

  const noUpper = renderStatsText(mk({
    current_pct: 75.3, estimated_full_days: 6, estimated_full_days_range: [4, null],
    trend_confidence: 'low', trend_window_days: 7, trend_note: 'ok'
  }), 'zh-CN');
  assert.match(noUpper, /存在回落，可能更久/);

  const insufficient = renderStatsText(mk({ current_pct: 75.3, trend_note: 'insufficient' }), 'zh-CN');
  assert.match(insufficient, /趋势数据不足/);
});
