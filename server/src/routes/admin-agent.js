'use strict';
// 受控端管理域（P2-1 拆分第五域，13 条路由）：
//   - 版本可判定性 / build-tag（/admin/agent-versions、/admin/agents/:id/build-tag）
//   - 告警阈值覆盖（/admin/alert-rules）
//   - 二进制 artifact 与批量分发（/admin/agent-artifacts、/admin/agent-distribution）
//
// 注意：/agents 前缀的 16 条路由（节点 CRUD / 指标 / 命令生成）按方案留在主文件，
// 本文件只收 /admin 前缀下与受控端运维相关的接口。

const express = require('express');
const fs = require('fs');
const db = require('../db');
const agentVersions = require('../agent-versions');
const distribution = require('../distribution');
const online = require('../online');
const { rateLimitTouch, bucketKey } = require('../ratelimit');
const { adminOnly, adminOrReadonly, agentScope, inAgentScope, auditLog } = require('../auth');
const { asyncHandler } = require('../util');
const { agentGlobalOnly } = require('./_shared');

const router = express.Router();

// ---- Admin: 受控端版本可判定性（V 阶段，AGENT_DISTRIBUTION_PLAN §2）----
// 目的：把「节点跑的是哪个版本」从 *仅 semver 字符串* 升级为
//       *版本 + commit SHA + 构建时间 + 平台 + 与期望版本的差距*。
//
// 三个端点：
//   GET  /admin/agent-versions              → 期望版本 + 分布汇总 + 每节点状态
//   PUT  /admin/agent-versions/expected     → 设置/清除「期望版本」
//   PUT  /admin/agents/:id/build-tag        → 标注节点构建（'' 清除 / 'custom' / 自由标签）
//
// 期望版本是**全局**配置 → 写接口要求全局作用域（节点白名单 Token 一律 forbidden_scope）。
// build_tag 是**节点级**标注 → 沿用节点白名单语义（inAgentScope）。
router.get('/admin/agent-versions', adminOnly, agentScope, (req, res) => {
  const expected = agentVersions.readExpected(db);
  // 节点白名单 Token 只看到授权范围内的节点（汇总随之只统计可见节点）。
  // 在线判定统一走 src/online.js（此前这里硬编码 5 分钟，与告警的 60s 默认口径完全不同）
  const octx = online.buildCtx();
  const nodes = db.getAgents()
    .filter((a) => inAgentScope(req, a.id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      online: online.isOnline(a, undefined, octx),
      version: a.version || '',
      build_sha: a.build_sha || '',
      build_time: a.build_time || '',
      platform: a.agent_platform || '',
      build_tag: a.build_tag || '',
      status: agentVersions.statusOf(a, expected)
    }));
  res.json({
    expected,
    counts: agentVersions.summarize(nodes, expected),
    nodes
  });
});

router.put('/admin/agent-versions/expected', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const body = req.body || {};
  const expected = agentVersions.writeExpected(db, { version: body.version, sha: body.sha });
  auditLog(req, 'agent_expected_version', `version=${expected.version || '(none)'} sha=${expected.sha || '(none)'}`);
  res.json({ ok: true, expected });
});

router.put('/admin/agents/:id/build-tag', adminOnly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  // tag 允许 ''（清除）、'custom'、自由标签；服务端只做长度截断，不猜语义。
  const tag = String(body.tag == null ? '' : body.tag).trim().slice(0, 32);
  db.setAgentBuildTag(a.id, tag);
  auditLog(req, 'agent_build_tag', `id=${a.id} tag=${tag || '(cleared)'}`);
  res.json({ ok: true, id: a.id, build_tag: tag });
});

// ---- Admin: 告警规则覆盖（S1/F1）----
// 语义：NULL/缺省 = 继承上层；PUT 为部分更新（body 中出现的键才覆盖，
// 显式 null 清除该字段回退上层）；DELETE 删除整行（全部回退）。
// 分组路径参数用 '-' 表示未分组默认组（空字符串无法作为路径段）。
const alertGroupKey = (raw) => (raw === '-' ? '' : String(raw || '').slice(0, 64));

router.get('/admin/alert-rules', adminOrReadonly, agentScope, (req, res) => {
  // S2/F5：告警阈值/覆盖列表含全局与全部节点配置，节点白名单 Token 不开放。
  if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
  res.json({
    global: db.resolveAlertThresholds(),
    groups: db.listGroupAlertOverrides(),
    agents: db.listAlertOverrides()
  });
});

router.put('/admin/alert-rules/agent/:id', adminOnly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const a = db.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const override = db.upsertAlertOverride(a.id, body);
  auditLog(req, 'alert_rule_update', `scope=agent id=${a.id} fields=${Object.keys(body).sort().join(',')}`);
  res.json({ ok: true, override });
});

router.delete('/admin/alert-rules/agent/:id', adminOnly, agentScope, (req, res) => {
  if (!inAgentScope(req, req.params.id)) return res.status(403).json({ error: 'forbidden_node' });
  const ok = db.deleteAlertOverride(req.params.id);
  auditLog(req, 'alert_rule_reset', `scope=agent id=${req.params.id}`);
  res.json({ ok, id: req.params.id });
});

router.put('/admin/alert-rules/group/:grp', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const grp = alertGroupKey(req.params.grp);
  const body = req.body || {};
  const override = db.upsertGroupAlertOverride(grp, body);
  auditLog(req, 'alert_rule_update', `scope=group grp=${grp || '(default)'} fields=${Object.keys(body).sort().join(',')}`);
  res.json({ ok: true, override });
});

router.delete('/admin/alert-rules/group/:grp', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const grp = alertGroupKey(req.params.grp);
  const ok = db.deleteGroupAlertOverride(grp);
  auditLog(req, 'alert_rule_reset', `scope=group grp=${grp || '(default)'}`);
  res.json({ ok, grp });
});

// ---- Admin: 受控端二进制 artifact + 一键批量分发（D 阶段）----
// 方案：dev-docs/AGENT_DISTRIBUTION_PLAN_2026-10-21.md §3
//
// 安全边界（方案 §0.2 / §D.6）：
//   - 服务端只**生成分发物**（脚本 + 二进制 + 校验和 + manifest），**不主动连接节点**；
//     节点上的执行动作始终由管理员发起（root / 管理员权限，与既有手动升级同一权限面）。
//   - artifact 文件名由服务端按内容哈希生成（<sha256>.bin|.exe），不含任何用户输入。
//   - 下载链接用一次性 HMAC 签名 token（默认 30 分钟过期、用后即焚）；
//     **绝不把 X-Admin-Token 放进 URL**（URL 会进 shell 历史与 access log）。
//   - 生成脚本只替换二进制，不写 /etc/diting/agent.env、不动 run_scheduled.bat
//     ⇒ 节点身份与自定义配置原样保留。

// 上传自定义受控端二进制。
// 用 octet-stream 原始 body（与既有 /admin/backups/upload 同一范式）：
// 无 multipart 解析器 ⇒ 零新增依赖；platform / source_note 走 query 参数。
const AGENT_ARTIFACT_MAX_MB = Math.max(1, Math.min(1024, Number(process.env.AGENT_ARTIFACT_MAX_MB) || 100));
const artifactRawParser = (req, res, next) => {
  express.raw({ type: () => true, limit: AGENT_ARTIFACT_MAX_MB * 1024 * 1024 })(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'too_large',
        message: `受控端二进制超过上限 ${AGENT_ARTIFACT_MAX_MB} MB`
      });
    }
    return res.status(400).json({ error: 'invalid_body', message: err.message || 'bad request body' });
  });
};

router.post('/admin/agent-artifacts', adminOnly, agentScope, agentGlobalOnly, artifactRawParser, (req, res) => {
  const platform = String(req.query.platform || '');
  const sourceNote = String(req.query.source_note || '');
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  const r = distribution.saveArtifact({ buf, platform, sourceNote });
  if (!r.ok) return res.status(r.code || 500).json({ error: r.error, platforms: r.platforms, max_bytes: r.max_bytes });
  const a = r.artifact;
  auditLog(req, 'agent_artifact_upload', `id=${a.id} platform=${a.platform} sha256=${a.sha256} size=${a.size}${r.deduped ? ' deduped=1' : ''}`);
  res.json({
    ok: true,
    artifact_id: a.id,
    sha256: a.sha256,
    platform: a.platform,
    size: a.size,
    uploaded_at: a.created_at,
    deduped: !!r.deduped
  });
});

router.get('/admin/agent-artifacts', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  res.json({ list: distribution.listArtifacts() });
});

router.delete('/admin/agent-artifacts/:id', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const r = distribution.deleteArtifact(req.params.id);
  if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
  auditLog(req, 'agent_artifact_delete', `id=${r.id}`);
  res.json({ ok: true, id: r.id });
});

// 生成分发包（服务端只产出文件 + 一条命令，节点执行由管理员发起）。
router.post('/admin/agent-distribution', adminOnly, agentScope, agentGlobalOnly, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const agentIds = Array.isArray(body.agent_ids) ? body.agent_ids.map(String).slice(0, 200) : [];
  const target = body.target || {};
  const source = body.source || {};
  const expiresInMinutes = body.expires_in_minutes;
  const r = await distribution.createPackage({
    agentIds,
    target: { os: target.os, arch: target.arch },
    source: {
      kind: source.kind,
      artifact_id: source.artifact_id,
      release_url: source.release_url,
      release_sha256: source.release_sha256
    },
    expiresInMinutes
  });
  if (!r.ok) return res.status(r.code || 500).json({ error: r.error, supported: r.supported, got: r.got, artifact_platform: r.artifact_platform });
  const pkg = r.pkg;
  // 一次性 token：签名绑定 pkg_id + 过期时间；进程内用后即焚。
  const token = distribution.signToken(pkg.pkg_id, pkg.expires_at);
  // 下载基址取当前请求的协议 + Host（trust proxy 已启用 ⇒ 反映反代的 X-Forwarded-Proto）。
  const base = `${req.protocol}://${req.get('host')}`;
  const dlPath = `/api/admin/agent-distribution/${encodeURIComponent(pkg.pkg_id)}/download`;
  const downloadUrl = `${base}${dlPath}?t=${token}`;
  const commands = {
    linux: `curl -fsSL '${downloadUrl}' -o diting-agent-dist.tar.gz && tar xzf diting-agent-dist.tar.gz && sudo sh ./update.sh`,
    windows: `iwr '${downloadUrl}' -OutFile diting-agent-dist.zip; Expand-Archive -Path diting-agent-dist.zip -DestinationPath . -Force; .\\update.ps1`
  };
  auditLog(req, 'agent_distribution_create',
    `pkg=${pkg.pkg_id} platform=${pkg.platform} source=${source.kind || ''} agents=${agentIds.length} size=${pkg.size} sha256=${pkg.sha256}`);
  res.json({
    ok: true,
    pkg_id: pkg.pkg_id,
    kind: pkg.kind,
    download_url: downloadUrl,
    one_time_token: token,
    expires_at: pkg.expires_at,
    commands,
    manifest: pkg.manifest
  });
}));

// 下载分发包：独立于 adminOnly（只认一次性 token）。
// 单独限流：token 泄露时限制单 IP 的暴力尝试速度。
const DIST_DOWNLOAD_WINDOW = 60000, DIST_DOWNLOAD_MAX = 10;
const distDownloadHits = new Map();
const distDownloadLimit = (req, res, next) => {
  if (!rateLimitTouch(distDownloadHits, bucketKey(req.ip || req.socket.remoteAddress), DIST_DOWNLOAD_WINDOW, DIST_DOWNLOAD_MAX)) {
    return res.status(429).json({ error: 'too_many_requests' });
  }
  next();
};
router.get('/admin/agent-distribution/:pkg_id/download', distDownloadLimit, (req, res) => {
  const r = distribution.authorizeDownload(req.params.pkg_id, req.query.t);
  if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
  let st;
  try { st = fs.statSync(r.path); } catch (e) { return res.status(404).json({ error: 'not_found' }); }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition',
    `attachment; filename="${r.pkg.filename}"; filename*=UTF-8''${encodeURIComponent(r.pkg.filename)}`);
  auditLog(req, 'agent_distribution_download', `pkg=${r.pkg.pkg_id} size=${st.size}`);
  const stream = fs.createReadStream(r.path);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); });
  stream.pipe(res);
});

module.exports = router;
