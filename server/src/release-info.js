'use strict';
// ============================================================
// S5.3-4：受控端最新 Release 版本查询（面板「版本差」用）
//
// 面板要回答「hub 是什么版本、受控端最新发到哪了、哪些节点落后」。前两个问题都需要
// 一个上游事实源：GitHub 最新 agent release tag。
//
// 设计约束：
//   - **成功缓存 6h / 失败负缓存 10min**：/api/version 是匿名端点，不能每次请求都打
//     GitHub（限流 + 拖慢首屏）。冷启动时返回 null 并后台刷新，不阻塞响应。
//   - **in-flight 去重**：并发请求只发起一次上游调用。
//   - **失败静默**：上游不可达（内网/离线部署）时返回 null，面板隐藏版本差，
//     绝不影响 /api/version 主响应。
//   - fetcher 可注入（单测不打真实网络）。
//
// 去重靠共享的 inflight Promise 而不是布尔标志：标志会被并发分支提前清掉，
// 导致「去重」失效（本模块初版就踩过这个坑）。
// ============================================================

const OWNER = 'fengzone85';
const REPO = 'diting';
const API_LATEST = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

const TTL_MS = 6 * 3600 * 1000;
const NEG_TTL_MS = 10 * 60 * 1000; // 失败负缓存：避免上游故障时每请求重试
const UPSTREAM_TIMEOUT_MS = 10000;

let fetcher = null; // 测试注入：async (url, timeoutMs) => {status, body}
// at = 上次「结论」时间（成功或失败都算）；tag 为 null 表示当前无有效结论。
let cache = { tag: null, at: 0, err: null };
let inflight = null; // 进行中的刷新 Promise（并发去重靠它，不用布尔标志）

const defaultFetcher = async (url, timeoutMs) => {
  if (typeof fetch !== 'function') throw new Error('fetch unavailable');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/vnd.github+json' } });
    const body = Buffer.from(await r.arrayBuffer());
    return { status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
};

// 纯刷新：只更新 {tag, at, err}，不碰 pending。返回最新 tag 或 null。
async function refresh() {
  let tag = null;
  let err = null;
  try {
    const r = await (fetcher || defaultFetcher)(API_LATEST, UPSTREAM_TIMEOUT_MS);
    if (r && r.status === 200) {
      const j = JSON.parse(r.body.toString('utf8'));
      if (j && typeof j.tag_name === 'string' && j.tag_name) tag = j.tag_name;
      else err = 'bad_response';
    } else {
      err = `http_${r ? r.status : 'nil'}`;
    }
  } catch (e) {
    err = String(e && e.message || e);
  }
  cache = { tag, at: Date.now(), err };
  return tag;
}

function isFresh() {
  const age = Date.now() - cache.at;
  return age < (cache.tag ? TTL_MS : NEG_TTL_MS);
}

// 发起刷新（进行中则复用同一個 Promise）。调用方负责在 .finally 里清理。
function startRefresh() {
  if (!inflight) inflight = refresh().finally(() => { inflight = null; });
  return inflight;
}

// 同步返回缓存的 tag；缓存过期时**后台刷新**（不阻塞 /api/version）。
// 返回 null = 未知（冷启动 / 上游失败），调用方应隐藏版本差而不是报错。
function latestAgentTag() {
  if (isFresh()) return cache.tag;
  startRefresh(); // 不 await：后台刷新，本期响应用旧值/null
  return cache.tag;
}

const _test = {
  setFetcher(fn) { fetcher = fn; cache = { tag: null, at: 0, err: null }; inflight = null; },
  reset() { cache = { tag: null, at: 0, err: null }; inflight = null; },
  refreshNow: () => startRefresh(),
  state: () => ({ tag: cache.tag, at: cache.at, err: cache.err, inflight: !!inflight }),
  API_LATEST,
};

module.exports = { latestAgentTag, _test };
