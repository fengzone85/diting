'use strict';
// /admin/notify/* 通知渠道与通知组（P2-1 拆分第二域）。
// 保留完整路径，主文件 router.use 平铺挂载；dashboard/layout 与 /test-alert 留在主文件。

const express = require('express');
const db = require('../db');
const notify = require('../notify');
const {
  NOTIFY_EVENTS, validateWebhookConfig, validateNotifyChannelInput, validateNotifyGroupInput,
} = require('../validate');
const { adminOnly, adminOrReadonly, agentScope, auditLog } = require('../auth');
const { asyncHandler } = require('../util');
const { agentGlobalOnly } = require('./_shared');

const router = express.Router();

// ---- Admin: 通知渠道 / 通知组（S1/F2）------------------------------------
// 渠道：mail/telegram 为内置（凭据仍在 notify_config，config 只读），webhook 可编辑。
// 组：events 支持 '*'；channel_ids 会过滤为实际存在的渠道，避免悬空绑定。
router.get('/admin/notify/events', adminOrReadonly, (req, res) => {
  res.json({ events: NOTIFY_EVENTS });
});

// S2/F2：通知配置迁移状态。用于后台横幅提示「旧的 notify_config 凭据已由默认通知组接管」。
// 判定是幂等的（不依赖一次性状态位）：旧凭据仍在 notify_config 中，且 default 组已存在
// ⇒ 迁移已生效。groups_enabled=false 表示运维用 NOTIFY_GROUPS=0 回退到了旧直发路径。
router.get('/admin/notify/migration-status', adminOrReadonly, (req, res) => {
  const cfg = db.getNotifyConfig();
  const groups = db.listNotifyGroups();
  const hasLegacy = !!(cfg.smtp_user || cfg.telegram_bot_token || cfg.telegram_chat_id);
  const defaultGroup = groups.find((g) => g.name === 'default');
  res.json({
    legacy_config_present: hasLegacy,
    default_group_present: !!defaultGroup,
    banner: hasLegacy && !!defaultGroup,
    groups_enabled: notify.groupsEnabled(),
  });
});

router.get('/admin/notify/channels', adminOrReadonly, (req, res) => {
  res.json(db.listNotifyChannels());
});

router.post('/admin/notify/channels', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const v = validateNotifyChannelInput(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const ch = db.createNotifyChannel(v.value);
    auditLog(req, 'notify_channel_create', `id=${ch.id} type=${ch.type} name=${ch.name}`);
    res.status(201).json(ch);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate_name' });
    throw e;
  }
});

router.put('/admin/notify/channels/:id', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const cur = db.getNotifyChannel(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim().slice(0, 64);
    if (!name) return res.status(400).json({ error: 'name_required' });
    patch.name = name;
  }
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.config !== undefined) {
    if (cur.type !== 'webhook') return res.status(400).json({ error: 'builtin_config_readonly' });
    const v = validateWebhookConfig(b.config);
    if (!v.ok) return res.status(400).json({ error: v.error });
    patch.config = v.config;
  }
  try {
    const ch = db.updateNotifyChannel(cur.id, patch);
    auditLog(req, 'notify_channel_update', `id=${ch.id} fields=${Object.keys(patch).sort().join(',')}`);
    res.json(ch);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate_name' });
    throw e;
  }
});

router.delete('/admin/notify/channels/:id', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const cur = db.getNotifyChannel(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (cur.type !== 'webhook') return res.status(400).json({ error: 'builtin_channel' });
  db.deleteNotifyChannel(cur.id);
  auditLog(req, 'notify_channel_delete', `id=${cur.id} name=${cur.name}`);
  res.json({ ok: true, id: cur.id });
});

router.post('/admin/notify/channels/:id/test', adminOnly, agentScope, agentGlobalOnly, asyncHandler(async (req, res) => {
  const ch = db.getNotifyChannel(req.params.id);
  if (!ch) return res.status(404).json({ error: 'not_found' });
  try {
    await notify.testChannel(ch.id);
    auditLog(req, 'notify_channel_test', `id=${ch.id} name=${ch.name}`);
    res.json({ ok: true });
  } catch (e) {
    // 细节只落日志（可能含目标信息），不回显客户端
    console.error(`[notify] test channel ${ch.id} failed:`, e.message);
    res.status(500).json({ error: 'send_failed', message: e.message });
  }
}));

router.get('/admin/notify/groups', adminOrReadonly, (req, res) => {
  res.json(db.listNotifyGroups());
});

router.post('/admin/notify/groups', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const v = validateNotifyGroupInput(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const valid = new Set(db.listNotifyChannels().map((c) => c.id));
  v.value.channel_ids = v.value.channel_ids.filter((id) => valid.has(id));
  try {
    const g = db.createNotifyGroup(v.value);
    auditLog(req, 'notify_group_create', `id=${g.id} name=${g.name} events=${g.events.join(',')}`);
    res.status(201).json(g);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate_name' });
    throw e;
  }
});

router.put('/admin/notify/groups/:id', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const cur = db.getNotifyGroup(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const v = validateNotifyGroupInput(Object.assign({}, cur, b));
  if (!v.ok) return res.status(400).json({ error: v.error });
  const valid = new Set(db.listNotifyChannels().map((c) => c.id));
  v.value.channel_ids = v.value.channel_ids.filter((id) => valid.has(id));
  try {
    const g = db.updateNotifyGroup(cur.id, v.value);
    auditLog(req, 'notify_group_update', `id=${g.id} name=${g.name} events=${g.events.join(',')}`);
    res.json(g);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate_name' });
    throw e;
  }
});

router.delete('/admin/notify/groups/:id', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const cur = db.getNotifyGroup(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  db.deleteNotifyGroup(cur.id);
  auditLog(req, 'notify_group_delete', `id=${cur.id} name=${cur.name}`);
  res.json({ ok: true, id: cur.id });
});

module.exports = router;
