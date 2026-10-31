'use strict';
// 管理端安全域（P2-1 拆分第四域，11 条路由）：
//   - API Token 签发/吊销（/admin/api-tokens）
//   - 登录会话管理（/admin/sessions）
//   - 2FA/TOTP（/admin/2fa）
//   - 审计日志查询（/admin/audit-logs）
//
// 这批路由在 api.js 里原本分散在两处（API Token 在节点/告警路由之后，会话/2FA 在文件末尾），
// 现已合并到同一域文件；主文件只需平铺挂载一次，对外路径零变化。

const express = require('express');
const db = require('../db');
const totp = require('../totp');
const { str } = require('../validate');
const {
  adminOnly, adminOrReadonly, requireAdmin, agentScope, auditLog,
  getSession, clearSessionCache, revokeAllSessions,
  verifyTotpOnce, totpGuard, recordTotpFailure,
} = require('../auth');
const { agentGlobalOnly } = require('./_shared');

const router = express.Router();

// ---- Admin: API Token 管理（S2/F5）----
// 明文仅在创建响应中出现一次，库中只存 SHA-256；列表接口不回显哈希。
// agent_ids=[] 表示不限节点；非空时该 Token 只能访问白名单内的节点（见 auth.agentScope）。
//
// 注意：本组接口对「自身已受限」的 Token 一律拒绝（forbidden_scope）。否则一个
// agent_ids=[A] 的 admin Token 只要再签发一个 agent_ids=[] 的 Token，就能绕过
// S2/F5 的节点边界实现越权——这是必须堵住的提权路径。
const API_TOKEN_SCOPES = ['readonly', 'admin'];

function parseAgentIds(raw) {
  if (raw === undefined || raw === null) return { ids: [] };
  if (!Array.isArray(raw)) return { error: 'invalid agent_ids' };
  const ids = Array.from(new Set(raw.map((x) => String(x).trim()).filter(Boolean))).slice(0, 500);
  for (const id of ids) {
    if (!db.getAgent(id)) return { error: 'unknown_agent_id' };
  }
  return { ids };
}

router.get('/admin/api-tokens', adminOnly, agentScope, (req, res) => {
  if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
  res.json({ list: db.listApiTokens() });
});

router.post('/admin/api-tokens', adminOnly, agentScope, (req, res) => {
  if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
  const body = req.body || {};
  const name = str(body.name, 64);
  if (!name) return res.status(400).json({ error: 'name required' });
  // 缺省最小权限（readonly）；非法值直接报错，避免静默降级成用户没预期的 scope。
  const scope = body.scope === undefined ? 'readonly' : String(body.scope);
  if (!API_TOKEN_SCOPES.includes(scope)) return res.status(400).json({ error: 'invalid_scope' });
  const parsed = parseAgentIds(body.agent_ids);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  let expiresAt = 0;
  if (body.expires_in_days !== undefined && body.expires_in_days !== null && body.expires_in_days !== '') {
    const days = Number(body.expires_in_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return res.status(400).json({ error: 'invalid_expires_in_days' });
    }
    expiresAt = Date.now() + days * 86400000;
  }
  const created = db.createApiToken({
    name,
    scope,
    agentIds: parsed.ids,
    expiresAt,
    createdBy: req.auth && req.auth.via ? String(req.auth.via).slice(0, 64) : ''
  });
  auditLog(req, 'api_token_create', `id=${created.id} name=${name} scope=${scope} agents=${parsed.ids.length || 'all'}`);
  res.json({
    id: created.id,
    name,
    scope,
    agent_ids: parsed.ids,
    expires_at: expiresAt,
    token: created.token,
    notice: '明文只返回这一次，请立即保存；丢失只能吊销后重建'
  });
});

router.delete('/admin/api-tokens/:id', adminOnly, agentScope, (req, res) => {
  if (req.agentScope) return res.status(403).json({ error: 'forbidden_scope' });
  const id = String(req.params.id || '');
  // 不存在或已吊销统一 404：UPDATE 对「已 revoked」的行同样算命中，
  // 不先查状态会让重复吊销返回 200，掩盖调用方拼错了 id 的情况。
  const tok = db.getApiToken(id);
  if (!tok || tok.revoked) return res.status(404).json({ error: 'not found' });
  // 吊销即时生效：resolveRole 每次请求都校验 revoked 标记。
  const ok = db.revokeApiToken(id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  auditLog(req, 'api_token_revoke', `id=${id}`);
  res.json({ ok: true, id });
});

// ---- Admin: 登录会话管理（S2/F6）----
// 会话列表含来源 IP 与 UA，属跨设备敏感信息：仅全局作用域管理员可读
//（adminOnly + agentScope + agentGlobalOnly；节点白名单 Token 一律 403 forbidden_scope）。
router.get('/admin/sessions', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const cur = getSession(req);
  const curSid = cur && cur.sid ? cur.sid : '';
  res.json({
    list: db.listSessions().map((r) => ({
      id: r.id,
      admin: r.admin,
      ip: r.ip,
      ua: r.ua,
      created_at: r.created_at,
      last_seen: r.last_seen,
      current: !!curSid && r.id === curSid,
    })),
  });
});

// 踢出单个会话（按 sid）。
router.delete('/admin/sessions/:id', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const id = String(req.params.id || '');
  // sid 为 24 位 hex（crypto.randomBytes(12)），白名单校验杜绝路径/注入类输入
  if (!/^[0-9a-f]{24}$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
  if (!db.revokeSession(id)) return res.status(404).json({ error: 'session not found' });
  // 缓存必须立即失效，否则被踢出的会话最多还能用 5 秒（缓存 TTL）
  clearSessionCache(id);
  auditLog(req, 'session_revoke', `id=${id}`);
  res.json({ ok: true });
});

// 批量吊销。keep_current 默认 true：踢掉其它设备但保留当前会话（否则管理员会把自己
// 也踢下线、操作中断）。keep_current=false → 等价全局吊销（含当前会话与全部历史会话，
// 通过 session_revoked_before 水位线覆盖）。
router.post('/admin/sessions/revoke-all', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const keepCurrent = (req.body || {}).keep_current !== false;
  const cur = getSession(req);
  const curSid = cur && cur.sid ? cur.sid : '';
  if (keepCurrent && curSid) {
    const n = db.revokeAllSessionRowsExcept(curSid);
    clearSessionCache();
    auditLog(req, 'session_revoke_all', `kept=${curSid} n=${n}`);
    res.json({ ok: true, revoked: n, kept_current: true });
  } else {
    const n = revokeAllSessions();
    auditLog(req, 'session_revoke_all', `n=${n} scope=all`);
    res.json({ ok: true, revoked: n, kept_current: false });
  }
});

// ---- Admin 2FA (TOTP) 管理 ----
router.get('/admin/2fa/status', adminOrReadonly, (req, res) => {
  res.json({ enabled: db.is2FAEnabled() });
});

// 生成密钥（尚未启用）。仅 admin 可调用；返回明文密钥仅此一次，供手动录入 Authenticator。
router.post('/admin/2fa/setup', requireAdmin, agentScope, agentGlobalOnly, (req, res) => {
  if (db.is2FAEnabled()) return res.status(400).json({ error: '2fa already enabled' });
  const secret = totp.generateSecret();
  db.set2FASecret(secret);
  res.json({ secret, otpauth_uri: totp.otpauthUri(secret), enabled: false });
});

router.post('/admin/2fa/enable', requireAdmin, agentScope, agentGlobalOnly, (req, res) => {
  const { code } = req.body || {};
  const secret = db.get2FASecret();
  if (!secret) return res.status(400).json({ error: 'run setup first' });
  if (!totpGuard(req)) return res.status(429).json({ error: 'too many totp failures', need_totp: true });
  // 防重放（L-2）：同一时间步的码只能成功一次
  if (!code || !verifyTotpOnce(secret, code)) {
    recordTotpFailure(req);
    return res.status(400).json({ error: 'invalid code' });
  }
  db.set2FAEnabled(true);
  // 安全状态变更：吊销既有会话，强制所有设备用新安全基线重新登录
  revokeAllSessions();
  res.json({ ok: true, enabled: true });
  auditLog(req, '2fa_enable', 'sessions revoked');
});

router.post('/admin/2fa/disable', requireAdmin, agentScope, agentGlobalOnly, (req, res) => {
  const { code } = req.body || {};
  if (!db.is2FAEnabled()) return res.status(400).json({ error: '2fa not enabled' });
  const secret = db.get2FASecret();
  if (!totpGuard(req)) return res.status(429).json({ error: 'too many totp failures', need_totp: true });
  // 防重放（L-2）：同一时间步的码只能成功一次
  if (!code || !secret || !verifyTotpOnce(secret, code)) {
    recordTotpFailure(req);
    return res.status(400).json({ error: 'invalid code' });
  }
  db.set2FAEnabled(false);
  // 安全状态变更：吊销既有会话，防止 2FA 关闭前的旧会话继续持有管理员权限
  revokeAllSessions();
  res.json({ ok: true, enabled: false });
  auditLog(req, '2fa_disable', 'sessions revoked');
});

// ---- Admin: 审计日志查询 ----
// S2/F5：审计条目里含全部节点的 id/名称与操作轨迹（detail 如 `id=agt_xxx`），
// 属跨节点信息，节点白名单 Token 不开放（它无法被裁剪成「只有自己的记录」）。
router.get('/admin/audit-logs', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const logs = db.getAuditLogs(limit, offset);
  const total = db.countAudit();
  res.json({ logs, total, limit, offset });
});

module.exports = router;
