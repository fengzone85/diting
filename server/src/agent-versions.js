'use strict';
// ============================================================
// V 阶段：受控端版本可判定性（期望版本对照 + 状态判定）
//
// 方案：dev-docs/AGENT_DISTRIBUTION_PLAN_2026-10-21.md §2（V.1–V.4）
//
// 判定口径（§V.4 契约）：
//   custom     : build_tag 非空（管理员显式标注的定制构建）—— 人工标注优先于一切自动判定
//   unknown    : 未设期望版本，或该节点没有任何可比对的版本信息
//   up_to_date : 期望 sha 非空 → build_sha 相同；否则期望 version 与节点 version 归一后相同
//   outdated   : 设了期望且可比对，但不匹配
//
// 为什么需要 normVer 归一：
//   2026-10-24 真机实测存量格式不统一（j4125=1.0.9、wxwin-go=v1.0.8、n5100=1.0.9），
//   直接字符串比较会把 `v1.0.8` 误判成 outdated。
//
// 为什么「期望 sha 但节点没有 sha」判 unknown 而不是 outdated：
//   老版本受控端不携带 build_sha，硬判 outdated 会把「无法判定」说成「确定落后」。
//   判定宁保守不夸大——unknown 才提示管理员去升级 agent。
//
// 本模块是纯逻辑（不碰 db、不发请求），便于单测；读/写期望版本时由调用方传入 db。
// ============================================================

// 期望版本在 admin_config 里的键名（与其它 ui_* / *_config 键同表）。
const EXPECTED_CONFIG_KEY = 'agent_expected_version';

// 版本号最大长度（与 validate.js 的 agent_meta.version 口径一致）。
const MAX_VER_LEN = 32;
// 期望 sha：7–40 位 hex（与 validate.js 的 build_sha 口径一致，杜绝注入面）。
const SHA_RE = /^[0-9a-f]{7,40}$/;

// 版本号归一：去空白 + 去可选 v 前缀 + 小写。
// `v1.0.9` / `1.0.9` / `V1.0.9` 视为同一版本。
function normVer(v) {
  return String(v == null ? '' : v).trim().replace(/^v/i, '').toLowerCase();
}

// 清洗管理员填写的「期望版本」：version 截断到 32 字符；sha 必须是 7–40 hex，否则丢弃。
// 非法输入不抛错——期望版本只是对照基准，填错不该把整个配置接口打成 500。
function sanitizeExpected(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const version = String(o.version == null ? '' : o.version).trim().slice(0, MAX_VER_LEN);
  const shaRaw = String(o.sha == null ? '' : o.sha).trim().toLowerCase();
  const sha = SHA_RE.test(shaRaw) ? shaRaw : '';
  return { version, sha };
}

// 读期望版本（存 admin_config，值是 JSON 串）。库中无值/值损坏 → 空期望（不做对照）。
function readExpected(db) {
  let raw = null;
  try { raw = db.getConfig(EXPECTED_CONFIG_KEY); } catch (e) { raw = null; }
  if (!raw) return { version: '', sha: '' };
  try {
    return sanitizeExpected(JSON.parse(raw));
  } catch (e) {
    return { version: '', sha: '' };
  }
}

// 写期望版本。两者皆空 = 清除期望（回到「只展示、不对照」）。
function writeExpected(db, expected) {
  const e = sanitizeExpected(expected);
  db.setConfig(EXPECTED_CONFIG_KEY, JSON.stringify(e));
  return e;
}

// 期望版本是否有效（非空即可参与对照）。
function hasExpected(expected) {
  const e = expected || {};
  return !!(String(e.version || '').trim() || String(e.sha || '').trim());
}

// 单节点状态判定。
function statusOf(node, expected) {
  const n = node || {};
  // 1) 人工标注优先：管理员标了 build_tag（'custom' 或自由标签）⇒ 定制构建，不参与自动对照。
  if (String(n.build_tag || '').trim()) return 'custom';
  const e = sanitizeExpected(expected || {});
  // 2) 没有期望版本 ⇒ 无对照基准，一律 unknown（只展示，不判定）。
  if (!hasExpected(e)) return 'unknown';
  const sha = String(n.build_sha || '').trim().toLowerCase();
  const ver = String(n.version || '').trim();
  // 3) 以 sha 为准（版本号可撞号，fork 与官方可能同号）。
  if (e.sha) {
    if (!sha) return 'unknown';           // 老 agent 不上报 sha ⇒ 无法判定
    return sha === e.sha ? 'up_to_date' : 'outdated';
  }
  // 4) 以版本号为准（归一后比较，忽略 v 前缀差异）。
  if (!ver) return 'unknown';
  return normVer(ver) === normVer(e.version) ? 'up_to_date' : 'outdated';
}

// 汇总计数：total / up_to_date / outdated / unknown / custom。
function summarize(nodes, expected) {
  const list = Array.isArray(nodes) ? nodes : [];
  const counts = { total: list.length, up_to_date: 0, outdated: 0, unknown: 0, custom: 0 };
  for (const n of list) {
    const s = statusOf(n, expected);
    if (counts[s] === undefined) counts[s] = 0;
    counts[s] += 1;
  }
  return counts;
}

module.exports = {
  EXPECTED_CONFIG_KEY,
  MAX_VER_LEN,
  normVer,
  sanitizeExpected,
  readExpected,
  writeExpected,
  hasExpected,
  statusOf,
  summarize,
};
