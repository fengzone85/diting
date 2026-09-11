// 备份目录管理：列出 / 下载 / 删除 / 恢复。
//
// 背景：备份由宿主侧 diting.sh 执行（容器内默认访问不到宿主 /var/backups/diting）。
// 要让后台能管理备份文件，必须把宿主备份目录挂进容器（BACKUP_DIR + compose 卷），
// 本模块只负责在「已挂载的目录」内做文件操作，所有路径都经 resolveBackupFile 白名单校验。
//
// 环境变量：
//   BACKUP_DIR     备份目录（默认 /data/backups，对应 compose 的备份卷）
//   RESTORE_TRIGGER 恢复触发文件路径（默认 /data/restore.request）
//   BACKUP_ALLOW_HOST_RESTORE=1 时才尝试直接触发宿主恢复命令；否则只投递请求文件
const fs = require('node:fs');
const path = require('node:path');

const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';
const RESTORE_TRIGGER = process.env.RESTORE_TRIGGER || '/data/restore.request';

// 只允许本脚本自己生成的备份命名，杜绝任意文件读取/删除
const NAME_RE = /^(monitor|pre_restore)_[0-9]{8}_[0-9]{6}\.db(\.gz)?$/;

function ensureDir() {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) { /* 只读挂载等场景忽略 */ }
}

// 校验并解析为绝对路径；非法返回 null（调用方一律 400/404，不回显用户输入）
function resolveBackupFile(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const full = path.join(BACKUP_DIR, name);
  // 二次确认：即使正则被绕过，也不允许逃出备份目录
  if (!full.startsWith(BACKUP_DIR + path.sep)) return null;
  return full;
}

function listBackups() {
  ensureDir();
  let names;
  try { names = fs.readdirSync(BACKUP_DIR); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue; // 目录里其它文件（日志、人工拷贝）不展示
    const full = path.join(BACKUP_DIR, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    out.push({
      name,
      size_bytes: st.size,
      mtime: st.mtimeMs,
      compressed: name.endsWith('.gz'),
      kind: name.startsWith('pre_restore_') ? 'pre_restore' : 'monitor'
    });
  }
  // 新的在前
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function backupSummary() {
  const list = listBackups();
  const monitor = list.filter((f) => f.kind === 'monitor');
  return {
    dir: BACKUP_DIR,
    count: list.length,
    monitor_count: monitor.length,
    total_bytes: list.reduce((s, f) => s + (f.size_bytes || 0), 0),
    latest_mtime: list.length ? list[0].mtime : 0
  };
}

// 快速校验备份是否为 SQLite：不压缩读文件头；gzip 看魔数 1f 8b。
// 只读前 16 字节，不整文件读取（备份可能几百 MB）。
function inspectFile(full, name) {
  let fd;
  try {
    fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    if (read < 2) return { ok: false, reason: 'file too small' };
    if (name.endsWith('.gz')) {
      const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
      return isGzip ? { ok: true, compressed: true } : { ok: false, reason: 'not a gzip file' };
    }
    const head = buf.slice(0, 15).toString('latin1');
    return head === 'SQLite format 3' ? { ok: true, compressed: false } : { ok: false, reason: 'not a sqlite database' };
  } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'not found' : (e.message || 'read error') };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
}

function deleteBackup(name) {
  const full = resolveBackupFile(name);
  if (!full) return { ok: false, code: 400, error: 'invalid name' };
  try {
    fs.unlinkSync(full);
    return { ok: true, name };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, code: 404, error: 'not found' };
    return { ok: false, code: 500, error: e.message || 'delete failed' };
  }
}

// 写入恢复请求，交由宿主侧 diting.sh 消费。
// 刻意不直接改数据库：直接改只能改容器内副本/卷内当前库路径，且无法兼顾
// 「恢复前先备份当前状态」等安全步骤，交给脚本实现更可靠。
function requestRestore(name) {
  const full = resolveBackupFile(name);
  if (!full) return { ok: false, code: 400, error: 'invalid name' };
  const chk = inspectFile(full, name);
  if (!chk.ok) return { ok: false, code: 400, error: chk.reason };
  ensureDir();
  const payload = JSON.stringify({ file: full, name, ts: Date.now() });
  try {
    fs.writeFileSync(RESTORE_TRIGGER, payload, { mode: 0o600 });
    return { ok: true, name, trigger: RESTORE_TRIGGER };
  } catch (e) {
    return { ok: false, code: 500, error: e.message || 'cannot write restore request' };
  }
}

function readRestoreRequest() {
  try {
    const raw = fs.readFileSync(RESTORE_TRIGGER, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function clearRestoreRequest() {
  try { fs.unlinkSync(RESTORE_TRIGGER); return true; } catch (e) { return false; }
}

module.exports = {
  BACKUP_DIR,
  RESTORE_TRIGGER,
  NAME_RE,
  resolveBackupFile,
  listBackups,
  backupSummary,
  inspectFile,
  deleteBackup,
  requestRestore,
  readRestoreRequest,
  clearRestoreRequest
};
