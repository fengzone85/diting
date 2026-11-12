#!/usr/bin/env node
// scripts/repo-hygiene-check.mjs — 仓库纯净度闸门（H1–H9）
// 零依赖（纯 node 内置模块），入库。
//
// 用法：
//   node scripts/repo-hygiene-check.mjs --staged                 # pre-commit：查暂存区
//   node scripts/repo-hygiene-check.mjs --full                   # CI：查 tracked 全集 + 工作树
//   node scripts/repo-hygiene-check.mjs --msg-file <path>        # commit-msg：查提交信息（仅提示，恒放行）
//   node scripts/repo-hygiene-check.mjs --test-baseline [--tap-file <path>]  # H9 测试基线防假绿
//
// 设计（对应方案 D16/D17/D19/D21）：
//   H1 白名单 = 目录级放行 + 禁入优先（fail-closed）；删除/重命名按原路径判定即放行。
//   H7 强特征赋值仅对非测试文件生效；排除变量引用与标识符形态；纯十六进制 ≥24 位除外。
//   H9 本地只告警（CI 环境变量为真时阻断）。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const CI = !!process.env.CI;

// ── H1 白名单（D16：目录级放行 + 禁入优先）──────────────────────────────
// .githooks/ 为闸门自身与例外通道所在，必须放行（方案 3.1 允许前缀补充项）。
const ALLOW_PREFIXES = [
  'server/', 'agent-go/', 'docs/', '.github/', 'scripts/', 'nginx/', '.githooks/',
];
const ALLOW_FILES = new Set([
  'README.md', 'README_EN.md', 'LICENSE', 'diting.sh', 'docker-compose.yml', '.gitignore',
]);
const DENY_PREFIXES = [
  'server/node_modules/', 'server/web/node_modules/', 'server/public/assets/',
  'server/web/coverage/', 'server/data/', 'server/certs/',
  'server/public/index.html.bak',
  'docs/node_modules/', 'docs/dist/', 'docs/.astro/',
  'plans/',
];
const DENY_EXACT = new Set(['DEVLOG.md', 'CHANGELOG.md', 'server/.env']);
const DENY_SEGMENTS = new Set([
  'node_modules', '.vscode', '.idea', '.codebuddy', '.zcode', '.workbuddy', '.trae',
]);
const DENY_EXTS = ['.map', '.pem', '.key', '.exe', '.db', '.sqlite', '.zip', '.pfx'];

// 例外通道（每行一条路径前缀或精确路径，# 开头为注释）
function loadAllowlist() {
  const p = path.join(ROOT, '.githooks', 'hygiene-allowlist.txt');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}
const EXTRA_ALLOW = loadAllowlist();

function denyReason(p) {
  const segs = p.split('/');
  for (const s of segs) if (DENY_SEGMENTS.has(s)) return `禁入目录 ${s}/`;
  for (const pre of DENY_PREFIXES) if (p === pre.replace(/\/$/, '') || p.startsWith(pre)) return `禁入前缀 ${pre}`;
  if (DENY_EXACT.has(p)) return `禁入文件 ${p}`;
  for (const ext of DENY_EXTS) if (p.endsWith(ext)) return `禁扩展名 ${ext}`;
  if (p.endsWith('.tar.gz')) return '禁扩展名 .tar.gz';
  return null;
}
function allowedPath(p) {
  if (EXTRA_ALLOW.some((a) => p === a || p.startsWith(a))) return true;
  if (denyReason(p)) return false;
  return ALLOW_FILES.has(p) || ALLOW_PREFIXES.some((pre) => p.startsWith(pre));
}

// ── 通用工具 ─────────────────────────────────────────────────────────────
const errors = [];
const warns = [];
const err = (code, msg) => errors.push(`[${code}] ${msg}`);
const warn = (code, msg) => warns.push(`[${code}] ${msg}`);

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function stagedEntries() {
  // name-status -z：记录以 \0 分隔；R/C 后跟旧路径与新路径
  const out = git(['diff', '--cached', '--name-status', '-z']).split('\0');
  const entries = [];
  for (let i = 0; i < out.length; i++) {
    const status = out[i];
    if (!status) continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      entries.push({ kind, oldPath: out[++i], newPath: out[++i] });
    } else {
      entries.push({ kind, oldPath: out[++i], newPath: null });
    }
  }
  return entries;
}
const isTestPath = (p) => /\.test\.[cm]?[jt]sx?$|\.e2e\.mjs$|(^|\/)test\//.test(p);
function readWorktree(p) {
  const fp = path.join(ROOT, p);
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return null;
  const buf = fs.readFileSync(fp);
  if (buf.includes(0)) return null; // 二进制跳过
  return buf.toString('utf8');
}

// ── H7 凭据扫描（D17 修正 + D21 ②c′）────────────────────────────────────
const TOKEN_PATTERNS = [
  ['私钥块', /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['云厂商 token(AKIA/ASIA)', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['sk- token', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['Google token', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
];
const ASSIGN_RE = /(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|token|private[_-]?key)\s*[:=]\s*['"]([^'"\s]{12,})['"]/gi;
const PLACEHOLDER_RE = /xxx|test|example|dummy|changeme|your_|placeholder|</i;

function scanCredentials(p, text) {
  for (const [label, re] of TOKEN_PATTERNS) {
    if (re.test(text)) err('H7', `${p}：命中${label}特征（阻断）`);
  }
  if (isTestPath(p)) return; // 修正①：强特征赋值仅对非测试文件生效
  for (const m of text.matchAll(ASSIGN_RE)) {
    const rhs = m[2];
    if (rhs.startsWith('$')) continue;                       // 修正②a：变量引用
    if (PLACEHOLDER_RE.test(rhs)) continue;                  // 占位符
    if (/^[a-z0-9_.]+$/.test(rhs) && !/^[a-f0-9]{24,}$/.test(rhs)) continue; // 修正②b + D21 ②c′
    err('H7', `${p}：强特征赋值 ${m[0].slice(0, 60)}…（阻断；如确需入库请走 .githooks/hygiene-allowlist.txt）`);
  }
}

// ── H5 提交信息（提示级，D3）────────────────────────────────────────────
const MSG_WORDS = [
  /\bkomari\b/i, /\bnezha\b/i, /哪吒/, /\bglassmorphism\b/i, /\bpurcarte\b/i,
  /\bcandyhouse\b/i, /\bcodebuddy\b/i, /\bqoder\b/i, /\bcf-vps-monitor\b/i,
  /\bPulse\b/, /\b[Tt]rae\b/,
];

function checkMessage(msg) {
  for (const re of MSG_WORDS) {
    const m = msg.match(re);
    if (m) warn('H5', `提交信息含第三方/其它项目名「${m[0]}」——请改用中性表述（提示级，不阻断）`);
  }
}

// ── H4 tracked 违禁扫描 ─────────────────────────────────────────────────
function checkTracked(files) {
  for (const p of files) {
    const segs = p.split('/');
    if (segs.includes('node_modules')) err('H4', `tracked 含 node_modules：${p}`);
    if (/(^|\/)public\/assets\//.test(p)) err('H4', `tracked 含构建产物目录 public/assets/：${p}`);
    if (/(^|\/)coverage\//.test(p)) err('H4', `tracked 含覆盖率目录 coverage/：${p}`);
    if (/(^|\/)dist\//.test(p)) err('H4', `tracked 含构建产物目录 dist/：${p}`);
    if (segs[segs.length - 1] === '.env') err('H4', `tracked 含 .env：${p}`);
  }
}

// ── H8 IDE/AI 工具目录 ──────────────────────────────────────────────────
function checkIdeDirs(files) {
  const ide = ['.vscode', '.idea', '.codebuddy', '.zcode', '.workbuddy', '.trae'];
  for (const p of files) {
    if (p.split('/').some((s) => ide.includes(s))) err('H8', `tracked 含 IDE/AI 工具目录：${p}`);
  }
  // 未跟踪存在 → 提示（跳过 node_modules）
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (!d.isDirectory()) continue;
      if (d.name === 'node_modules' || d.name === '.git') continue;
      const rel = path.relative(ROOT, path.join(dir, d.name));
      if (ide.includes(d.name)) warn('H8', `仓库内出现 IDE/AI 工具目录（未跟踪）：${rel}/ —— 应集中放工作区根`);
      else walk(path.join(dir, d.name), depth + 1);
    }
  };
  walk(ROOT, 0);
}

// ── H9 测试基线防假绿 ───────────────────────────────────────────────────
function walkFiles(dir, re, out = []) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    const fp = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name === 'node_modules' || d.name === '.git') continue;
      walkFiles(fp, re, out);
    } else if (re.test(d.name)) out.push(fp);
  }
  return out;
}

function checkTestBaseline(tapFile) {
  const serverTests = walkFiles(path.join(ROOT, 'server', 'test'), /\.test\.js$/).length;
  const webTests = walkFiles(path.join(ROOT, 'server', 'web', 'src'), /\.test\.ts$/).length;
  const report = (level, code, msg) => (CI && level === 'error' ? err(code, msg) : warn(code, msg));

  if (serverTests < 70) report('error', 'H9', `服务端测试文件 ${serverTests} 个 < 阈值 70（防假绿）`);
  else console.log(`[H9] 服务端测试文件 ${serverTests} ≥ 70 ✓`);
  if (webTests < 20) report('error', 'H9', `前端用例文件 ${webTests} 个 < 阈值 20（防假绿）`);
  else console.log(`[H9] 前端用例文件 ${webTests} ≥ 20 ✓`);

  if (tapFile) {
    const tap = fs.readFileSync(tapFile, 'utf8');
    const pass = Number(/^# pass (\d+)$/m.exec(tap)?.[1] ?? -1);
    const fail = Number(/^# fail (\d+)$/m.exec(tap)?.[1] ?? -1);
    if (pass < 600) report('error', 'H9', `TAP pass=${pass} < 阈值 600（防假绿）`);
    else console.log(`[H9] TAP pass=${pass} ≥ 600 ✓`);
    if (fail !== 0) err('H9', `TAP fail=${fail}，必须为 0`);
  } else {
    warn('H9', '未提供 --tap-file，跳过 TAP 用例数断言（CI 必须提供）');
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = argv[0];
const msgFile = argv.includes('--msg-file') ? argv[argv.indexOf('--msg-file') + 1] : null;
const tapFile = argv.includes('--tap-file') ? argv[argv.indexOf('--tap-file') + 1] : null;

if (mode === '--msg-file' && msgFile) {
  checkMessage(fs.readFileSync(msgFile, 'utf8'));
} else if (mode === '--test-baseline') {
  checkTestBaseline(tapFile);
} else if (mode === '--staged' || mode === '--full') {
  const files = git(['ls-files']).split('\n').filter(Boolean);

  // H4 / H6 / H8：tracked 全集
  checkTracked(files);
  checkIdeDirs(files);
  const staged = mode === '--staged' ? stagedEntries() : [];
  const projected = files.length + staged.filter((e) => e.kind === 'A').length;
  if (projected >= 800) err('H6', `tracked 文件数 ${projected} ≥ 800（阻断上限）`);
  else if (projected >= 600) warn('H6', `tracked 文件数 ${projected} ≥ 600（预警）`);

  if (mode === '--staged') {
    for (const e of staged) {
      if (e.kind === 'D') continue; // D19：删除一律放行
      const judge = e.kind === 'R' || e.kind === 'C' ? e.oldPath : e.oldPath; // D19：按原路径判定
      if (!allowedPath(judge)) {
        err('H1', `staged 路径越界：${judge}（${denyReason(judge) ?? '不在允许前缀内'}；确需入库走 .githooks/hygiene-allowlist.txt）`);
        continue;
      }
      // 新增/修改侧：扩展名（H2）与体积（H3）
      const target = e.newPath ?? e.oldPath;
      if (e.kind !== 'R' || e.newPath) {
        const r = denyReason(target);
        if (r && /禁扩展名/.test(r)) err('H2', `staged 文件命中${r}：${target}`);
        const fp = path.join(ROOT, target);
        if (fs.existsSync(fp) && fs.statSync(fp).size > 512 * 1024) {
          err('H3', `staged 文件超过 512KB：${target}`);
        }
      }
    }
  } else {
    // --full：全集逐个过 H1（存量零误报判据 I8）
    for (const p of files) {
      if (!allowedPath(p)) err('H1', `tracked 路径越界：${p}（${denyReason(p) ?? '不在允许前缀内'}）`);
    }
  }

  // H7：凭据扫描（--staged 扫 staged 存量；--full 扫全部 tracked）
  const scanTargets = mode === '--staged'
    ? staged.filter((e) => e.kind !== 'D').map((e) => e.newPath ?? e.oldPath)
    : files;
  for (const p of scanTargets) {
    if (p === '.env.example' || p.endsWith('.md')) continue;
    const text = readWorktree(p);
    if (text != null) scanCredentials(p, text);
  }
} else {
  console.error('用法：--staged | --full | --msg-file <path> | --test-baseline [--tap-file <path>]');
  process.exit(2);
}

for (const w of warns) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
if (errors.length) {
  console.error(`repo-hygiene：${errors.length} 项阻断、${warns.length} 项提示`);
  process.exit(1);
}
console.log(`repo-hygiene 通过（${warns.length} 项提示）`);
