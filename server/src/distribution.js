'use strict';
// ============================================================
// D 阶段：一键批量分发（服务端只「生成分发物」，执行始终由管理员在节点上发起）
//
// 方案：dev-docs/AGENT_DISTRIBUTION_PLAN_2026-10-21.md §3（D.1–D.6）
//
// 红线（沿用方案 §0.2，本模块逐条落地）：
//   1. 不新增 agent 出站目标：agent 仍只上报服务端一个地址；
//   2. 不解析 agent 上报响应（单向上报模型不变）；
//   3. 不扩 agent 权限：替换二进制由**管理员以 root 在节点上执行脚本**完成，
//      与既有 `diting.sh --update-agent` 是同一个模型，不是新机制；
//   4. 不建立服务端→agent 指令通道：服务端只生成文本/文件，不主动推送；
//   5. 不破坏 agent 身份：分发脚本**只替换二进制**，绝不写
//      /etc/diting/agent.env（Linux）或 run_scheduled.bat（Windows）
//      ⇒ AGENT_ID/AGENT_TOKEN/PROBE_TARGETS/MONTH_ROTATE 原样保留；
//   6. 不引重量级依赖：tar.gz 用 node:zlib 手写最小 tar 容器，zip 复用既有 adm-zip。
//
// 安全要点：
//   - artifact 文件名由服务端按内容哈希生成（<sha256>.bin|.exe），**不含任何用户输入**；
//   - 生成脚本时所有动态值走白名单 + 引号转义（sha256/文件名/pkg_id 均为受控字面量）；
//   - 下载链接用一次性 HMAC 签名 token（默认 30 分钟过期、用后即焚），
//     **绝不把 X-Admin-Token 放进 URL**（URL 会进 shell 历史与 access log）；
//   - sha256 校验必须在替换二进制**之前**，失败路径必须回滚。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const db = require('./db');
const { safeDownload, sha256 } = require('./theme-market');
// 官方来源复用签名中继的取件逻辑（验签 + 架构校验已在其中），不另写 GitHub 客户端。
const relay = require('./agent-relay');
const { SESSION_SECRET } = require('./auth');

// ---- 目录与上限 ----
// 与 DB 同级（Docker 下随卷持久），沿用 theme.js 的 THEMES_DIR 先例。
const ARTIFACT_DIR = process.env.AGENT_ARTIFACT_DIR
  ? path.resolve(process.env.AGENT_ARTIFACT_DIR)
  : path.join(path.dirname(db.DB_PATH), 'agent-artifacts');
const PKG_DIR = process.env.AGENT_DISTRIBUTION_DIR
  ? path.resolve(process.env.AGENT_DISTRIBUTION_DIR)
  : path.join(path.dirname(db.DB_PATH), 'agent-distributions');

// 受控端平台白名单（方案 D.3）。darwin 只允许作为 artifact 的平台标注，
// 分发目标仍限 linux / windows（方案 D.3 的 target 口径）。
const PLATFORMS = ['linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-amd64', 'darwin-arm64'];
const TARGET_OS = ['linux', 'windows'];
const TARGET_ARCH = ['amd64', 'arm64'];

// 单个 artifact 上限 100MB（方案 D.6）；分发包 = 二进制 + 脚本 + manifest，留 20% 余量。
const ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;
const PKG_MAX_BYTES = Math.floor(ARTIFACT_MAX_BYTES * 1.2);
// 一次性下载链接有效期：默认 30 分钟（方案 D.3），上限 24 小时。
const DEFAULT_TTL_MIN = 30;
const MAX_TTL_MIN = 1440;

const SHA256_RE = /^[0-9a-f]{64}$/;

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 目录不可写时由调用方报错 */ }
}

// windows 平台的二进制带 .exe，其余不带扩展名（Linux 二进制不需要）。
function extOf(platform) {
  return String(platform).startsWith('windows-') ? '.exe' : '.bin';
}
function binaryNameOf(platform) {
  return String(platform).startsWith('windows-') ? 'diting-agent.exe' : 'diting-agent';
}

// ============================================================
// artifact（自定义二进制）上传 / 列表 / 删除
// ============================================================

/**
 * 保存一份自定义受控端二进制。
 * 返回 { ok, artifact, deduped } 或 { ok:false, code, error }。
 */
function saveArtifact({ buf, platform, sourceNote }) {
  if (!PLATFORMS.includes(String(platform || ''))) {
    return { ok: false, code: 400, error: 'invalid_platform', platforms: PLATFORMS };
  }
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, code: 400, error: 'empty_body' };
  }
  if (buf.length > ARTIFACT_MAX_BYTES) {
    return { ok: false, code: 413, error: 'too_large', max_bytes: ARTIFACT_MAX_BYTES };
  }
  const sha = sha256(buf);
  const filename = sha + extOf(platform);
  // 内容寻址：同内容天然去重（sha256 唯一约束）。
  const existing = db.getAgentArtifactBySha(sha);
  if (existing) return { ok: true, artifact: existing, deduped: true };

  ensureDir(ARTIFACT_DIR);
  const full = path.join(ARTIFACT_DIR, filename);
  // 原子落盘：同目录临时文件 + rename（rename 同文件系统内原子）。
  const tmp = `${full}.upload-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, full);
    try { fs.chmodSync(full, 0o600); } catch (e) { /* 某些文件系统不支持 chmod */ }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
    return { ok: false, code: 500, error: 'artifact_write_failed' };
  }
  const id = 'art_' + crypto.randomBytes(6).toString('hex');
  const artifact = db.insertAgentArtifact({
    id,
    sha256: sha,
    platform: String(platform),
    filename,
    size: buf.length,
    source_note: String(sourceNote || '').slice(0, 200),
    created_at: Date.now()
  });
  return { ok: true, artifact, deduped: false };
}

const listArtifacts = () => db.listAgentArtifacts();

/** 删除 artifact（库行 + 磁盘文件）。 */
function deleteArtifact(id) {
  const a = db.getAgentArtifact(id);
  if (!a) return { ok: false, code: 404, error: 'not found' };
  const full = path.join(ARTIFACT_DIR, a.filename);
  // 二次确认目录（文件名虽由服务端生成，仍做一次边界检查）。
  if (path.dirname(path.resolve(full)) === path.resolve(ARTIFACT_DIR)) {
    try { fs.unlinkSync(full); } catch (e) { /* 文件可能已不在 */ }
  }
  db.deleteAgentArtifact(id);
  return { ok: true, id: a.id };
}

// ============================================================
// 一次性下载 token（HMAC 签名 + 用后即焚）
// ============================================================

// 从 SESSION_SECRET 派生专用 key（方案 D.3 修正：ADMIN_TOKEN 库中只有哈希、明文不可得，
// 不能用作 HMAC 密钥）。SESSION_SECRET 未配置时 auth.js 会随机生成 ⇒ 进程重启后旧链接失效。
const TOKEN_KEY = crypto.createHmac('sha256', SESSION_SECRET).update('diting-agent-distribution-v1').digest();

function signToken(pkgId, expiresAt) {
  return crypto.createHmac('sha256', TOKEN_KEY).update(`${pkgId}:${expiresAt}`).digest('hex');
}

function verifyToken(pkgId, expiresAt, token) {
  const expect = Buffer.from(signToken(pkgId, expiresAt), 'hex');
  let given;
  try { given = Buffer.from(String(token || ''), 'hex'); } catch (e) { return false; }
  if (given.length !== expect.length || given.length === 0) return false;
  return crypto.timingSafeEqual(expect, given);
}

// 已用过的包（一次性）：pkg_id → 该包的过期时间戳。进程内 Map，重启即清空（链接随之失效）。
// 注意存的是**过期时间**而不是「用掉的时间」：判定重放时先看标记是否存在，
// 若包已过期则连同标记一起清理（此时链接本来就该失效）。
const usedPackages = new Map();

function isPackageUsed(pkgId) {
  const expiresAt = usedPackages.get(String(pkgId));
  if (expiresAt === undefined) return false;
  if (expiresAt < Date.now()) { usedPackages.delete(String(pkgId)); return false; }
  return true;
}

function consumePackage(pkgId, expiresAt) {
  usedPackages.set(String(pkgId), Number(expiresAt) || Date.now());
}

// 清理过期包：库行 + 磁盘文件 + 已用标记。
function pruneExpired() {
  const now = Date.now();
  try {
    const rows = db.prepare('SELECT * FROM agent_distributions WHERE expires_at < ?').all(now - 24 * 3600 * 1000);
    for (const r of rows) {
      const full = path.join(PKG_DIR, r.filename);
      if (path.dirname(path.resolve(full)) === path.resolve(PKG_DIR)) {
        try { fs.unlinkSync(full); } catch (e) { /* 忽略 */ }
      }
    }
  } catch (e) { /* 忽略 */ }
  try { db.pruneAgentDistributions(now); } catch (e) { /* 忽略 */ }
  for (const [k, v] of usedPackages) if (v < now) usedPackages.delete(k);
}

// ============================================================
// 分发脚本模板（人工可审阅；动态值全部是受控字面量）
// ============================================================

// Linux：只替换 /opt/diting/diting-agent，不碰 /etc/diting/agent.env。
function renderUpdateSh({ pkgId, platform, generatedAt }) {
  const binName = binaryNameOf(platform);
  return `#!/bin/sh
# 由 diting 服务端生成的一次性受控端升级脚本（可人工审阅后再执行）。
# 包 id   : ${pkgId}
# 目标平台: ${platform}
# 生成时间: ${generatedAt}
#
# 本脚本只做一件事：用包内的新二进制替换 /opt/diting/diting-agent。
# 它**不会**写 /etc/diting/agent.env ⇒ AGENT_ID / AGENT_TOKEN / PROBE_TARGETS /
# MONTH_ROTATE 等身份与自定义配置全部原样保留。
# 需要 root 权限执行（写入 /opt/diting 是 root 权限面，与日常手动升级一致）。
set -eu

BIN_DIR=/opt/diting
BIN="$BIN_DIR/diting-agent"
ENV_FILE=/etc/diting/agent.env
HERE="$(cd "$(dirname "$0")" && pwd)"
NEW_BIN="$HERE/${binName}"
SHA_FILE="$HERE/${binName}.sha256"

log() { printf '[diting-update] %s\\n' "$*"; }
die() { printf '[diting-update][FATAL] %s\\n' "$*" >&2; exit 1; }

# 回滚：必须与升级路径一样「写临时文件 + 原子 mv」。
# 直接 cp 覆盖**运行中**的二进制会报 "Text file busy"（ETXTBSY）——
# 这是真机验证抓到的真实故障：服务在跑时回滚会失败，监控节点变成"半坏"状态。
rollback() {
  install -m 755 "$1" "$BIN.rollback.tmp" || return 1
  mv -f "$BIN.rollback.tmp" "$BIN" || return 1
  systemctl restart diting-agent || true
  return 0
}

# 0. 前置检查：root / systemd / 既有安装
[ "$(id -u)" = "0" ] || die "需要 root 权限执行"
command -v systemctl >/dev/null 2>&1 || die "未找到 systemctl（该节点可能不是 systemd 环境）"
[ -f "$ENV_FILE" ] || die "未找到 $ENV_FILE（受控端未安装或身份文件缺失，已中止）"
[ -f "$NEW_BIN" ] || die "包内缺少新二进制 $NEW_BIN"
[ -f "$SHA_FILE" ] || die "包内缺少校验文件 $SHA_FILE"

# 1. sha256 校验（必须在替换之前；不匹配立即退出，不动现有二进制）
( cd "$HERE" && sha256sum -c "$(basename "$SHA_FILE")" ) || die "sha256 校验失败，已中止（未做任何替换）"

# 2. 备份（命名带时分秒：同一天多次升级时后一次不能覆盖前一次的备份，
#    否则回滚链会断在"当天最早的那个版本"）
STAMP="$(date +%Y%m%d-%H%M%S)"
BAK="$BIN_DIR/diting-agent.bak-$STAMP"
cp -a "$BIN" "$BAK" || die "备份失败：$BAK"
log "已备份当前二进制到 $BAK"

# 3. 原子替换（先写临时文件再 mv，避免运行中的二进制被写坏）
install -m 755 "$NEW_BIN" "$BIN.tmp" || die "写入临时文件失败：$BIN.tmp"
mv -f "$BIN.tmp" "$BIN" || die "替换失败：$BIN"

# 4. 重启服务
if ! systemctl restart diting-agent; then
  log "重启失败，开始回滚到 $BAK"
  rollback "$BAK"
  die "已回滚到 $BAK，请人工确认"
fi

# 5. 健康检查（不依赖网络回连；节点失联场景下也能正确回滚）
sleep 3
if ! systemctl is-active --quiet diting-agent; then
  log "服务未处于 active，开始回滚到 $BAK"
  rollback "$BAK"
  die "已回滚到 $BAK，请人工确认"
fi

log "升级完成：diting-agent 当前状态 $(systemctl is-active diting-agent)"
log "如需回滚：sh -c 'install -m 755 $BAK $BIN.rollback.tmp && mv -f $BIN.rollback.tmp $BIN' && systemctl restart diting-agent"
`;
}

// Windows：只替换 %ProgramData%\diting-agent\diting-agent.exe，
// **不碰 run_scheduled.bat**（身份与自定义配置都在那个文件里）。
//
// ⚠️ 必须带 UTF-8 BOM：Windows PowerShell 5.1 读取**无 BOM** 的 .ps1 时按 ANSI(GBK) 解析，
//    脚本里的中文注释/提示会被解成乱码，某些字节被误当作字符串终止符 ⇒ 直接 ParserError
//    （真机验证实测：「字符串缺少终止符」）。加 BOM 后 5.1 与 7 都能正确按 UTF-8 解析。
const PS1_BOM = '\ufeff';

function renderUpdatePs1({ pkgId, platform, generatedAt, agentId }) {
  const binName = binaryNameOf(platform);
  const taskName = `HostMonitorAgent-${agentId || ''}`;
  const body = `# 由 diting 服务端生成的一次性受控端升级脚本（Windows，可人工审阅后再执行）。
# 包 id   : ${pkgId}
# 目标平台: ${platform}
# 生成时间: ${generatedAt}
#
# 本脚本只替换 %ProgramData%\\diting-agent\\${binName}，
# 不会改写 run_scheduled.bat ⇒ SERVER_URL / AGENT_ID / AGENT_TOKEN /
# INTERVAL / MONTH_ROTATE / PROBE_TARGETS 原样保留。
# 需要**管理员权限**运行（PowerShell）。
$ErrorActionPreference = 'Stop'
# 控制台按 UTF-8 输出（否则中文提示在 SSH/远程会话里是乱码，运维读不懂）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$InstallDir = Join-Path $env:ProgramData 'diting-agent'
$Exe = Join-Path $InstallDir '${binName}'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$NewExe = Join-Path $Here '${binName}'
$ShaFile = Join-Path $Here '${binName}.sha256'
$TaskName = '${taskName}'
# 备份名带时分秒：同一天多次升级时后一次不能覆盖前一次的备份（回滚链要完整）
$Stamp = (Get-Date -Format 'yyyyMMdd-HHmmss')
$Backup = Join-Path $InstallDir ('diting-agent.exe.bak-' + $Stamp)

function Say([string]$m) { Write-Host "[diting-update] $m" }
function Die([string]$m) { Write-Host "[diting-update][FATAL] $m" -ForegroundColor Red; exit 1 }

# 0. 前置检查
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Die '需要管理员权限运行（请用「以管理员身份运行」的 PowerShell）'
}
if (-not (Test-Path $Exe)) { Die "未找到现有二进制 $Exe（受控端未安装？）" }
if (-not (Test-Path $NewExe)) { Die "包内缺少新二进制 $NewExe" }
if (-not (Test-Path $ShaFile)) { Die "包内缺少校验文件 $ShaFile" }

# 1. sha256 校验（必须在替换之前）
$expected = ((Get-Content $ShaFile -Raw) -split '\\s+')[0].Trim().ToLower()
$actual = (Get-FileHash -Algorithm SHA256 -Path $NewExe).Hash.ToLower()
if ($expected -ne $actual) { Die "sha256 校验失败（期望 $expected 实得 $actual），已中止（未做任何替换）" }

# 2. 备份
Copy-Item -Path $Exe -Destination $Backup -Force
Say "已备份当前二进制到 $Backup"

# 3. 停任务 → 结束残留进程 → 替换 → 启任务
#    注意：Windows 不允许替换**运行中**的 exe（文件被锁定），
#    因此必须先停计划任务并结束残留进程，否则 Copy-Item 会失败。
if ($TaskName) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Seconds 2
}
Get-Process -Name 'diting-agent' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 复制到临时文件再原子替换（避免半写坏的 exe）
try {
  Copy-Item -Path $NewExe -Destination "$Exe.new" -Force
  Move-Item -Path "$Exe.new" -Destination $Exe -Force
} catch {
  Copy-Item -Path $Backup -Destination $Exe -Force
  Die "替换失败并已回滚：$($_.Exception.Message)"
}

# 4. 启任务并检查状态
$ok = $false
if ($TaskName) {
  try {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    $state = (Get-ScheduledTask -TaskName $TaskName).State
    $ok = ($state -ne 'Disabled')
  } catch {
    $ok = $false
  }
}
if (-not $ok) {
  # 回滚同样要先结束进程（运行中的 exe 不可替换）
  Get-Process -Name 'diting-agent' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Copy-Item -Path $Backup -Destination $Exe -Force
  if ($TaskName) { try { Start-ScheduledTask -TaskName $TaskName } catch {} }
  Die "任务未正常启动，已回滚到 $Backup"
}

Say "升级完成：$Exe 已替换，计划任务 $TaskName 已启动"
Say "如需回滚：先 Stop-Process -Name diting-agent -Force，再 Copy-Item '$Backup' '$Exe' -Force，然后 Start-ScheduledTask -TaskName '$TaskName'"
`;
  return PS1_BOM + body;
}

// ============================================================
// tar.gz（手写最小 ustar 容器 + zlib）——零新增依赖
// ============================================================

function tarHeader(name, size, mtimeSec, mode) {
  const h = Buffer.alloc(512);
  h.write(String(name).slice(0, 100), 0, 100, 'utf8');
  h.write((mode & 0o7777).toString(8).padStart(7, '0'), 100, 8, 'utf8');
  h.write('0000000', 108, 8, 'utf8');   // uid
  h.write('0000000', 116, 8, 'utf8');   // gid
  // 注意：八进制转换必须作用在 **number** 上。
  // 写成 String(size).toString(8) 会被字符串的 toString 忽略参数 ⇒ 落盘十进制 ⇒
  // GNU tar 解析 size/mtime 失败（"归档包含 … 而需要数字值 time_t"）。
  h.write(Number(size).toString(8).padStart(11, '0'), 124, 12, 'utf8');
  h.write(Number(Math.floor(mtimeSec)).toString(8).padStart(11, '0'), 136, 12, 'utf8');
  h.write('        ', 148, 8, 'utf8');  // checksum 占位（空格）
  h.write('0', 156, 1, 'utf8');         // typeflag = 普通文件
  h.write('ustar\0', 257, 6, 'utf8');
  h.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return h;
}

function buildTarGz(entries, mtimeSec) {
  const chunks = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    chunks.push(tarHeader(e.name, data.length, mtimeSec, e.mode || 0o644));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024)); // 两个空块 = 归档结束标记
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

function buildZip(entries) {
  const zip = new AdmZip();
  for (const e of entries) {
    zip.addFile(e.name, Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8'));
  }
  return zip.toBuffer();
}

// ============================================================
// 官方来源（official）：从官方 Release 取受控端二进制
// ============================================================
//
// 为什么复用 agent-relay 而不是自己写 GitHub 客户端：
//   relay.prepare() 已经做完「解 tag → 下载资产 → **ed25519 验签** → **架构校验(fail closed)**
//   → 落盘缓存」这一整套，其中验签与架构校验是安全逻辑，重复实现只会出现两套口径。
//
// 额外一道交叉校验：
//   官方 release 里同时有 <asset>.sha256 资产（CI 生成）。把它与**本地计算**的 sha256 比对，
//   两者必须一致 —— 防御 CDN 内容损坏 / 资产被替换 / 中间人改写。
//   若官方 sha256 资产取不到（老 release 没有），则退化为「只信验签」，并在 manifest 里标记
//   verified=false；此时管理员可用 source.release_sha256 额外指定期望值做人工把关。
//
async function fetchOfficialBinary(os, arch) {
  const key = `${os}/${arch}`;
  if (!relay.ASSETS[key]) {
    return { ok: false, code: 400, error: 'official_platform_unsupported', supported: Object.keys(relay.ASSETS) };
  }
  let bin, tag;
  try {
    const out = await relay.prepare(key, false);
    bin = out.buf;
    tag = out.tag;
  } catch (e) {
    return {
      ok: false,
      code: e.status || 502,
      error: e.code || 'official_fetch_failed',
      message: String((e && e.message) || e),
      hint: '官方 Release 不可达或资产缺失；可改用 source.kind=release_url 或先上传 artifact'
    };
  }
  const local = sha256(bin);
  let officialSha = '';
  try {
    const out = await relay.prepare(key, true);
    officialSha = out.buf.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
  } catch (e) {
    officialSha = ''; // 老 release 可能没有 .sha256 资产
  }
  if (officialSha) {
    if (!/^[0-9a-f]{64}$/.test(officialSha)) {
      return { ok: false, code: 502, error: 'official_sha_malformed' };
    }
    if (officialSha !== local) {
      return { ok: false, code: 502, error: 'official_sha_mismatch', got: local, want: officialSha };
    }
  }
  return { ok: true, buf: bin, sha256: local, tag, verified: !!officialSha };
}

// ============================================================
// 分发包生成
// ============================================================

/**
 * 生成分发包。
 * opts: { agentIds, target:{os,arch}, source:{kind,artifact_id?,release_url?,release_sha256?}, expiresInMinutes }
 * 返回 { ok, pkg } 或 { ok:false, code, error }。
 */
async function createPackage(opts = {}) {
  const agentIds = Array.isArray(opts.agentIds) ? opts.agentIds.map(String).slice(0, 200) : [];
  const os = String((opts.target && opts.target.os) || '');
  const arch = String((opts.target && opts.target.arch) || '');
  if (!TARGET_OS.includes(os)) return { ok: false, code: 400, error: 'invalid_target_os' };
  if (!TARGET_ARCH.includes(arch)) return { ok: false, code: 400, error: 'invalid_target_arch' };
  const platform = `${os}-${arch}`;

  const source = opts.source || {};
  const kind = String(source.kind || '');
  let binary = null;      // Buffer：包内二进制
  let binarySha = '';     // 二进制 sha256
  let sourceRef = '';     // 库中记录的来源标识（artifact_id 或 官方 tag#artifact_id）
  let sourceNote = '';
  let officialVerified = false;

  if (kind === 'artifact') {
    const art = db.getAgentArtifact(source.artifact_id);
    if (!art) return { ok: false, code: 404, error: 'artifact_not_found' };
    if (art.platform !== platform) {
      return { ok: false, code: 400, error: 'artifact_platform_mismatch', artifact_platform: art.platform };
    }
    const full = path.join(ARTIFACT_DIR, art.filename);
    try { binary = fs.readFileSync(full); } catch (e) { return { ok: false, code: 404, error: 'artifact_file_missing' }; }
    binarySha = art.sha256;
    sourceRef = art.id;
    sourceNote = art.source_note || '';
  } else if (kind === 'release_url') {
    const url = String(source.release_url || '');
    const want = String(source.release_sha256 || '').toLowerCase();
    if (!/^https?:\/\//i.test(url)) return { ok: false, code: 400, error: 'invalid_release_url' };
    if (!SHA256_RE.test(want)) return { ok: false, code: 400, error: 'invalid_release_sha256' };
    let buf;
    try {
      // 复用主题市场的安全下载（钉 IP / 私网拦截 / 禁 3xx / 体积与超时上限）。
      buf = await safeDownload(url, { maxBytes: ARTIFACT_MAX_BYTES });
    } catch (e) {
      return { ok: false, code: 400, error: 'release_download_failed', message: String(e && e.message || e) };
    }
    const got = sha256(buf);
    if (got !== want) return { ok: false, code: 400, error: 'release_sha256_mismatch', got };
    // 校验通过后转存为 artifact（content-addressed）⇒ 分发包与 artifact 同源。
    const saved = saveArtifact({ buf, platform, sourceNote: `release_url ${new URL(url).host}` });
    if (!saved.ok) return { ok: false, code: saved.code || 500, error: saved.error };
    binary = buf;
    binarySha = got;
    sourceRef = saved.artifact.id;
    sourceNote = saved.artifact.source_note || '';
  } else if (kind === 'official') {
    const r = await fetchOfficialBinary(os, arch);
    if (!r.ok) {
      return { ok: false, code: r.code || 502, error: r.error, supported: r.supported, message: r.message, hint: r.hint };
    }
    // 管理员若额外指定了期望 sha，则必须与官方资产一致（人工把关的二次保险）
    const want = String(source.release_sha256 || '').toLowerCase();
    if (want && want !== r.sha256) {
      return { ok: false, code: 400, error: 'release_sha256_mismatch', got: r.sha256 };
    }
    binary = r.buf;
    binarySha = r.sha256;
    sourceRef = r.tag || '';
    sourceNote = `official ${r.tag || ''}${r.verified ? ' (sha256 已交叉校验)' : ' (仅验签)'}`;
    officialVerified = !!r.verified;
    // 官方资产同样转存为 artifact ⇒ 分发包与 artifact 同源，内容寻址天然去重
    const saved = saveArtifact({ buf: binary, platform, sourceNote });
    if (!saved.ok) return { ok: false, code: saved.code || 500, error: saved.error };
    sourceRef = `${r.tag || ''}#${saved.artifact.id}`;
  } else {
    return { ok: false, code: 400, error: 'unsupported_source', supported: ['artifact', 'release_url', 'official'] };
  }

  const ttlMin = Math.max(1, Math.min(MAX_TTL_MIN, Number(opts.expiresInMinutes) || DEFAULT_TTL_MIN));
  const now = Date.now();
  const expiresAt = now + ttlMin * 60 * 1000;
  const pkgId = 'pkg_' + crypto.randomBytes(8).toString('hex');
  const binName = binaryNameOf(platform);
  const generatedAt = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');

  const manifest = {
    pkg_id: pkgId,
    generated_at: generatedAt,
    expires_at: new Date(expiresAt).toISOString().replace(/\.\d+Z$/, 'Z'),
    source: { kind, ref: sourceRef, note: sourceNote, sha256_cross_checked: officialVerified },
    target: { os, arch, platform },
    binary: { name: binName, sha256: binarySha },
    agent_ids: agentIds,
    notice: '本包只含替换受控端二进制所需的最小内容，不含任何身份凭据；节点身份仍保留在本机。'
  };

  const shaFile = `${binarySha}  ${binName}\n`;
  const entries = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    { name: 'README.txt', data: renderReadme(manifest, ttlMin) },
    { name: `${binName}.sha256`, data: shaFile },
    { name: binName, data: binary }
  ];
  if (os === 'windows') {
    entries.push({
      name: 'update.ps1',
      data: renderUpdatePs1({ pkgId, platform, generatedAt, agentId: agentIds[0] || '' })
    });
  } else {
    entries.push({
      name: 'update.sh',
      data: renderUpdateSh({ pkgId, platform, generatedAt }),
      // 脚本必须带可执行位：README 里的用法是 `sudo sh ./update.sh`（双保险：不依赖可执行位）。
      // 真机验证发现漏掉 0755 会直接报「权限不够」。
      mode: 0o755
    });
  }

  const kindName = os === 'windows' ? 'zip' : 'tar.gz';
  const payload = kindName === 'zip'
    ? buildZip(entries)
    : buildTarGz(entries, Math.floor(now / 1000));
  if (payload.length > PKG_MAX_BYTES) {
    return { ok: false, code: 413, error: 'package_too_large' };
  }

  ensureDir(PKG_DIR);
  const filename = `${pkgId}.${kindName}`;
  const full = path.join(PKG_DIR, filename);
  try {
    fs.writeFileSync(full, payload, { mode: 0o600 });
    fs.chmodSync(full, 0o600);
  } catch (e) {
    return { ok: false, code: 500, error: 'package_write_failed' };
  }
  db.insertAgentDistribution({
    pkg_id: pkgId,
    platform,
    source_kind: kind,
    source_ref: sourceRef,
    sha256: binarySha,
    filename,
    size: payload.length,
    kind: kindName,
    expires_at: expiresAt,
    created_at: now
  });
  return {
    ok: true,
    pkg: {
      pkg_id: pkgId,
      kind: kindName,
      platform,
      size: payload.length,
      sha256: binarySha,
      expires_at: expiresAt,
      manifest,
      filename
    }
  };
}

function renderReadme(manifest, ttlMin) {
  return `diting 受控端分发包
===================

包 id   : ${manifest.pkg_id}
生成时间: ${manifest.generated_at}
有效期  : ${manifest.expires_at}（${ttlMin} 分钟；过期后下载链接失效）
目标平台: ${manifest.target.platform}
来源    : ${manifest.source.kind}${manifest.source.ref ? ' (' + manifest.source.ref + ')' : ''}
二进制  : ${manifest.binary.name}
sha256  : ${manifest.binary.sha256}

用法
----
Linux   : tar xzf <包名> && sudo sh ./update.sh
Windows : 解压后，在「管理员 PowerShell」中执行 .\\update.ps1

脚本会做四件事（可先阅读再执行）：
  1. 校验包内二进制的 sha256（不匹配立即退出，不动现有二进制）；
  2. 备份当前二进制为 diting-agent[.exe].bak-YYYYMMDD-HHMMSS；
  3. 原子替换二进制并重启受控端服务；
  4. 健康检查失败时自动回滚到备份。

注意
----
* 脚本**不会**写 /etc/diting/agent.env（Windows 侧不动 run_scheduled.bat）
  ⇒ 身份与自定义配置（AGENT_ID / AGENT_TOKEN / PROBE_TARGETS / MONTH_ROTATE）原样保留；
* 替换动作需要 root / 管理员权限——这是既有手动升级的权限面，不是新增提权面；
* 本包不含任何凭据；下发与执行都由管理员在本机完成，服务端不主动连接节点。
`;
}

// ============================================================
// 下载
// ============================================================

/**
 * 校验并消费一次性下载 token。
 * 返回 { ok:true, pkg, path } 或 { ok:false, code, error }。
 */
function authorizeDownload(pkgId, token) {
  const pkg = db.getAgentDistribution(pkgId);
  if (!pkg) return { ok: false, code: 404, error: 'not_found' };
  if (pkg.expires_at < Date.now()) return { ok: false, code: 410, error: 'expired' };
  if (isPackageUsed(pkg.pkg_id)) return { ok: false, code: 410, error: 'token_used' };
  if (!verifyToken(pkg.pkg_id, pkg.expires_at, token)) return { ok: false, code: 403, error: 'invalid_token' };
  const full = path.join(PKG_DIR, pkg.filename);
  // 二次确认目录（文件名由服务端生成，仍做边界检查）。
  if (path.dirname(path.resolve(full)) !== path.resolve(PKG_DIR)) {
    return { ok: false, code: 404, error: 'not_found' };
  }
  consumePackage(pkg.pkg_id, pkg.expires_at);
  return { ok: true, pkg, path: full };
}

module.exports = {
  ARTIFACT_DIR, PKG_DIR, PLATFORMS, TARGET_OS, TARGET_ARCH,
  ARTIFACT_MAX_BYTES, DEFAULT_TTL_MIN, MAX_TTL_MIN,
  saveArtifact, listArtifacts, deleteArtifact,
  createPackage, authorizeDownload, pruneExpired,
  signToken, verifyToken, isPackageUsed, consumePackage,
  buildTarGz, buildZip, renderUpdateSh, renderUpdatePs1, binaryNameOf, extOf
};
