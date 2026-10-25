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
const { spawnSync } = require('node:child_process');

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
  // F8.3：列表附完整性状态。deep integrity_check 对大库可达数秒，不能对每个文件
  // 每次都跑：这里每个请求最多抽查 1 个未缓存文件（quick_check），其余标 unknown，
  // 多刷新几次即可覆盖；恢复前的强制校验（requestRestore）仍用完整 integrity_check。
  const budget = { left: INTEGRITY_LIST_BUDGET };
  for (const name of names) {
    if (!NAME_RE.test(name)) continue; // 目录里其它文件（日志、人工拷贝）不展示
    const full = path.join(BACKUP_DIR, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const integ = listIntegrity(full, name, st, budget);
    out.push({
      name,
      size_bytes: st.size,
      mtime: st.mtimeMs,
      compressed: name.endsWith('.gz'),
      kind: name.startsWith('pre_restore_') ? 'pre_restore' : 'monitor',
      integrity: integ.status,
      integrity_reason: integ.reason || ''
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

// ---- F8.3 完整性预检 ----
// 用**子进程**跑 PRAGMA，是为了拿到硬超时：better-sqlite3 是同步 API，主进程里对
// 一个几 GB 的库做 integrity_check 会卡住整个事件循环，且无法从外部中断。
// deep=true 用 integrity_check（恢复前强制，失败拒绝恢复）；false 用 quick_check
// （列表抽查，成本低，只用于展示 ok/fail/unknown 三态）。
const INTEGRITY_TIMEOUT_MS = 10000;
const INTEGRITY_MAX_BUFFER = 256 * 1024;
const INTEGRITY_LIST_BUDGET = 1; // 每次列表最多抽查 1 个未缓存文件
const integrityCache = new Map(); // name -> { key, status, reason, checked_at }

let betterSqlitePath = '';
try { betterSqlitePath = require.resolve('better-sqlite3'); } catch (e) { /* 子进程会返回 unknown */ }

const INTEGRITY_SCRIPT = `
const Database = require(process.argv[1]);
const file = process.argv[2];
const mode = process.argv[3];
let db;
try {
  db = new Database(file, { readonly: true, fileMustExist: true });
  const rows = db.pragma(mode);
  const v = rows && rows[0] ? Object.values(rows[0])[0] : '';
  process.stdout.write(String(v));
} catch (e) {
  process.stdout.write('ERROR: ' + (e.message || e));
} finally {
  try { if (db) db.close(); } catch (e) { /* ignore */ }
}
`;

function inspectIntegrity(full, name, opts = {}) {
  // gzip 备份无法就地打开：解压后的完整性由 diting.sh 在恢复流程里校验
  if (typeof name === 'string' && name.endsWith('.gz')) {
    return { status: 'unknown', reason: 'compressed backup; verified after extraction on restore' };
  }
  if (!betterSqlitePath) return { status: 'unknown', reason: 'better-sqlite3 not resolvable' };
  const mode = opts.deep ? 'integrity_check' : 'quick_check';
  const r = spawnSync(process.execPath, ['-e', INTEGRITY_SCRIPT, betterSqlitePath, full, mode], {
    timeout: INTEGRITY_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: INTEGRITY_MAX_BUFFER
  });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT' || r.signal) {
      return { status: 'timeout', reason: `check exceeded ${INTEGRITY_TIMEOUT_MS / 1000}s` };
    }
    return { status: 'unknown', reason: r.error.message || 'check process failed' };
  }
  if (r.status !== 0) {
    return { status: 'unknown', reason: (r.stderr || 'check process failed').trim().slice(0, 300) };
  }
  const out = String(r.stdout || '').trim();
  if (out === 'ok') return { status: 'ok' };
  if (out.startsWith('ERROR:')) return { status: 'fail', reason: out.slice(6).trim().slice(0, 300) };
  return { status: 'fail', reason: (out || 'not ok').slice(0, 300) };
}

// 列表用：只查未缓存的文件，且每次请求最多花一次子进程；超时不缓存（下次重试）。
function listIntegrity(full, name, st, budget) {
  if (typeof name === 'string' && name.endsWith('.gz')) {
    return { status: 'unknown', reason: 'compressed backup' };
  }
  const key = `${st.size}:${Math.round(st.mtimeMs)}`;
  const hit = integrityCache.get(name);
  if (hit && hit.key === key) return { status: hit.status, reason: hit.reason };
  if (budget.left <= 0) return { status: 'unknown', reason: 'not checked yet' };
  budget.left -= 1;
  const r = inspectIntegrity(full, name, { deep: false });
  if (r.status === 'timeout') return { status: 'unknown', reason: r.reason };
  integrityCache.set(name, { key, status: r.status, reason: r.reason || '', checked_at: Date.now() });
  return { status: r.status, reason: r.reason || '' };
}

// 判断上传内容是不是"能当作备份"的东西：
//   gzip 魔数 1f 8b（.db.gz）或 SQLite 文件头。只看头几个字节，不整文件读。
function detectUploadKind(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'gz';
  if (buf.slice(0, 15).toString('latin1') === 'SQLite format 3') return 'db';
  return null;
}

// 保存上传的备份。文件名**由服务端生成**（客户端给的名字一律丢弃），
// 这样 NAME_RE 白名单、列表/删除/恢复全都不受影响，也彻底避开路径穿越。
// 目录不可写时给出**可执行**的原因：服务端通常以非 root 用户跑，而备份是 root 的
// diting.sh 创建的，默认 root:root 755 → 上传写不进、下载也读不了。
function uploadBlockedReason() {
  try {
    fs.accessSync(BACKUP_DIR, fs.constants.W_OK);
    return '';
  } catch (e) {
    let user = '';
    try { user = require('node:os').userInfo().username; } catch (e2) { /* ignore */ }
    return user
      ? `backup dir not writable by server user "${user}"; run: sudo chown ${user} ${BACKUP_DIR}`
      : `backup dir not writable: ${BACKUP_DIR}`;
  }
}

function saveUploadedBackup(buf) {
  ensureDir();                       // 先建目录，否则 accessSync 会因 ENOENT 误判为"不可写"
  const blocked = uploadBlockedReason();
  if (blocked) return { ok: false, code: 503, error: blocked };
  const kind = detectUploadKind(buf);
  if (!kind) {
    return { ok: false, code: 400, error: 'not a sqlite database or gzip archive' };
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const name = `monitor_${stamp}.db${kind === 'gz' ? '.gz' : ''}`;
  const full = path.join(BACKUP_DIR, name);
  if (!full.startsWith(BACKUP_DIR + path.sep)) return { ok: false, code: 400, error: 'invalid name' };
  if (fs.existsSync(full)) return { ok: false, code: 409, error: 'name collision, retry in a second' };
  const tmp = `${full}.upload-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, full);   // 原子落盘：列表/恢复不会看到半截文件
    try { fs.chmodSync(full, 0o600); } catch (e) { /* 只读挂载等场景忽略 */ }
    return { ok: true, name, size: buf.length };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    return { ok: false, code: 500, error: e.message || 'write failed' };
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

// F8.1：应用内快照命名，与宿主脚本保持一致（monitor_YYYYMMDD_HHMMSS.db，本地时间），
// 这样宿主侧列表、清理、恢复都不需要区分来源。
function snapshotName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `monitor_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.db`;
}

// 写入恢复请求，交由宿主侧 diting.sh 消费。
// 刻意不直接改数据库：直接改只能改容器内副本/卷内当前库路径，且无法兼顾
// 「恢复前先备份当前状态」等安全步骤，交给脚本实现更可靠。
// actor（F8.6）：操作者标识，脚本恢复完成后会把它写进恢复后库的审计
// —— 否则「谁发起了恢复」这条记录会随旧库一起被覆盖。
function requestRestore(name, actor) {
  const full = resolveBackupFile(name);
  if (!full) return { ok: false, code: 400, error: 'invalid name' };
  const chk = inspectFile(full, name);
  if (!chk.ok) return { ok: false, code: 400, error: chk.reason };
  // F8.3：恢复前强制完整性预检（10s 超时），失败拒绝恢复并提示。
  // unknown（gzip 备份 / 子进程不可用）放行：gzip 由 diting.sh 解压后校验，
  // 工具异常也不该让用户完全无法恢复数据。
  const integ = inspectIntegrity(full, name, { deep: true });
  if (integ.status === 'fail') {
    return { ok: false, code: 400, error: `integrity check failed: ${integ.reason || 'database is corrupted'}` };
  }
  if (integ.status === 'timeout') {
    return { ok: false, code: 400, error: `integrity check timed out after ${INTEGRITY_TIMEOUT_MS / 1000}s` };
  }
  ensureDir();
  const payload = JSON.stringify({ file: full, name, ts: Date.now(), by: actor || 'admin' });
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
  INTEGRITY_TIMEOUT_MS,
  resolveBackupFile,
  listBackups,
  backupSummary,
  inspectFile,
  inspectIntegrity,
  snapshotName,
  detectUploadKind,
  saveUploadedBackup,
  deleteBackup,
  requestRestore,
  readRestoreRequest,
  clearRestoreRequest
};
