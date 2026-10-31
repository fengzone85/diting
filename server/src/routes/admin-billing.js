'use strict';
// 备份 / 容量保险丝 / 恢复审查（P2-1 拆分第三域，10 条路由）。
// 保留完整路径，主文件 router.use 平铺挂载。

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const backups = require('../backups');
const capacity = require('../capacity');
const { adminOnly, adminOrReadonly, agentScope, auditLog, actorLabel } = require('../auth');
const { agentGlobalOnly } = require('./_shared');

const router = express.Router();

// ---- Admin: 数据库备份监控（宿主侧 diting.sh 执行后回写的状态）----
// 服务端本身不执行备份（容器内访问不到宿主备份目录），仅负责展示与下发策略。
router.get('/admin/backup-status', adminOrReadonly, (req, res) => {
  const ui = db.getUiSettings();
  res.json({
    config: {
      schedule: ui.backup_schedule || 'off',
      hour: Number.isFinite(Number(ui.backup_hour)) ? Number(ui.backup_hour) : 3,
      keep_days: Number.isFinite(Number(ui.backup_keep_days)) ? Number(ui.backup_keep_days) : 14,
      compress: ui.backup_compress !== false
    },
    state: db.getBackupState(),
    // 文件管理可用性：容器内必须能读到备份目录（compose 需挂载宿主备份目录）
    files: backups.backupSummary(),
    files_available: fs.existsSync(backups.BACKUP_DIR),
    dir: backups.BACKUP_DIR
  });
});

// ---- Admin: 备份文件管理（列表 / 下载 / 删除 / 恢复）----
// 前提：宿主备份目录已挂进容器（compose 卷 + BACKUP_DIR），否则目录为空。
router.get('/admin/backups', adminOrReadonly, (req, res) => {
  res.json({
    dir: backups.BACKUP_DIR,
    available: fs.existsSync(backups.BACKUP_DIR),
    files: backups.listBackups(),
    restore_request: backups.readRestoreRequest(),
    // F8.6：最近一次恢复审查报告（恢复后由 server 启动流程写入）。
    // 报告含跨节点 agent_id，只读角色（节点白名单 Token）不返回，口径同审计日志。
    restore_audit: req.role === 'admin' ? db.getRestoreAuditReport() : null
  });
});

// 上传备份：把外部备份放进 BACKUP_DIR，之后可像本地备份一样"恢复"。
// 安全约束：
//   ① 只认 SQLite 头 / gzip 魔数，其它内容一律 400（不当文件暂存盘用）；
//   ② **文件名由服务端生成**，客户端给的名字整个丢弃 —— NAME_RE 白名单、列表/删除/恢复
//      都不受影响，也就不存在路径穿越面；
//   ③ 大小上限 BACKUP_UPLOAD_MAX_MB（默认 1024），超限 413；
//   ④ 仍要求管理端凭据 + HTTPS 反代（adminOnly 内含 requireProto）。
const BACKUP_UPLOAD_MAX_MB = Math.max(1, Math.min(8192, Number(process.env.BACKUP_UPLOAD_MAX_MB) || 1024));
const backupRawParser = (req, res, next) => {
  express.raw({ type: () => true, limit: BACKUP_UPLOAD_MAX_MB * 1024 * 1024 })(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'too_large',
        message: `备份文件超过上限 ${BACKUP_UPLOAD_MAX_MB} MB（可用环境变量 BACKUP_UPLOAD_MAX_MB 调整）`
      });
    }
    return res.status(400).json({ error: 'invalid_body', message: err.message || 'bad request body' });
  });
};
router.post('/admin/backups/upload', adminOnly, agentScope, agentGlobalOnly, backupRawParser, (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length === 0) return res.status(400).json({ error: 'empty_body', message: '请求体为空' });
  const r = backups.saveUploadedBackup(buf);
  if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
  res.json({ ok: true, name: r.name, size_bytes: r.size });
  auditLog(req, 'upload_backup', `name=${r.name} size=${r.size}`);
});

// 下载：流式返回，支持大文件；文件名经白名单校验，杜绝任意文件读取
router.get('/admin/backups/:name/download', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const full = backups.resolveBackupFile(req.params.name);
  if (!full) return res.status(400).json({ error: 'invalid backup name' });
  let st;
  try { st = fs.statSync(full); } catch (e) { return res.status(404).json({ error: 'not found' }); }
  if (!st.isFile()) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(st.size));
  // filename 用 origin 形式，避免非 ASCII 触发 header 解析问题
  res.setHeader('Content-Disposition',
    `attachment; filename="${req.params.name}"; filename*=UTF-8''${encodeURIComponent(req.params.name)}`);
  auditLog(req, 'download_backup', `name=${req.params.name} size=${st.size}`);
  const stream = fs.createReadStream(full);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); });
  stream.pipe(res);
});

router.delete('/admin/backups/:name', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const r = backups.deleteBackup(req.params.name);
  if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
  res.json({ ok: true, name: r.name });
  auditLog(req, 'delete_backup', `name=${r.name}`);
});

// ---- F12 容量保险丝：状态与一键清理 ----
// 只读角色也可看水位（与看板同类信息），清理必须管理员。
router.get('/admin/capacity', adminOrReadonly, (req, res) => {
  res.json(capacity.getStatus());
});

// 一键「清理并恢复」：只跑既有 retention 清理（不额外删数据、不 VACUUM）。
// 清完仍超限时前端会提示「缩短保留天数 / 调高阈值」，不会静默继续停写。
router.post('/admin/capacity/cleanup', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  const r = capacity.cleanup();
  res.json(r);
  auditLog(req, 'capacity_cleanup', `deleted=${r.deleted} level=${r.level} rows=${r.rows} bytes=${r.bytes}`);
});

// F8.1：应用内一致性快照（better-sqlite3 db.backup 在线备份，无需停服）。
// 产物沿用宿主脚本命名，宿主清理/恢复无需区分来源；.db（未压缩），
// 与上传件一样受保留策略管理（需长期保留请下载归档）。
router.post('/admin/backups', adminOnly, agentScope, agentGlobalOnly, async (req, res) => {
  const name = backups.snapshotName();
  const full = path.join(backups.BACKUP_DIR, name);
  try {
    fs.mkdirSync(backups.BACKUP_DIR, { recursive: true });
    if (fs.existsSync(full)) {
      return res.status(409).json({ error: 'backup name already exists, retry in a second' });
    }
    await db.backupTo(full);
    try { fs.chmodSync(full, 0o600); } catch (e) { /* 权限收紧失败不影响备份 */ }
    const st = fs.statSync(full);
    res.json({ ok: true, name, size_bytes: st.size, mtime: st.mtimeMs });
    auditLog(req, 'create_backup', `name=${name} size=${st.size}`);
  } catch (e) {
    try { fs.unlinkSync(full); } catch (err) { /* 清理半成品 */ }
    res.status(500).json({ error: (e && e.message) || 'backup failed' });
  }
});

// F8.6：最近一次恢复审查报告。后台布局用它渲染顶部黄条（「恢复自 N 天前的备份，
// X% 数据将被下次清理删除」），单独开接口避免为了一个提示拉整个备份目录。
router.get('/admin/restore-audit', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  res.json({ report: db.getRestoreAuditReport() });
});

// 恢复：不直接改数据库，而是投递恢复请求文件，由宿主侧 diting.sh 消费执行
// （脚本会先备份当前状态、校验完整性、停服原子替换再重启）。
router.post('/admin/backups/:name/restore', adminOnly, agentScope, agentGlobalOnly, (req, res) => {
  // actor 随请求文件交给脚本：恢复会覆盖当前库，这条 API 审计会随之消失，
  // 必须让「谁发起」跟着请求走到恢复后的库里（F8.6）。
  const r = backups.requestRestore(req.params.name, actorLabel(req));
  if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
  res.json({ ok: true, name: r.name, trigger: r.trigger, queued: true });
  auditLog(req, 'request_restore_backup', `name=${r.name}`);
});

module.exports = router;
