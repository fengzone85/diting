'use strict';
// 管理密码（人用凭据）的哈希与校验。机器凭据（Admin/API Token）仍走 token-policy.js。
//
// 存储格式：`scrypt$N$r$p$salt_b64$hash_b64`（参数随哈希入库，校验以库中参数为准）。
// KDF 用 Node 内置 crypto.scrypt —— 零新依赖；显式给 maxmem（默认 32MB 不够 N=32768）。
//
// 升级路径（r1/P1-4）：登录成功是唯一允许改写哈希的时机；库中参数弱于当前默认时
// rehash 升级写回。调参只升不降（降 N＝降安全）；慢（~100ms/次）是抗爆破特性。
//
// r3/P1-3：请求路径一律用**异步** KDF——scryptSync 会占住事件循环 ~100ms/次，
// 换 IP 并发打登录即可拖垮面板；async scrypt 在 libuv 线程池执行（默认 4 线程 =
// 天然并发上限）。同步版仅保留给测试/CLI 播种等非请求路径。
//
// r3/P1-4：verifyPasswordEqualizing 在「未设密码」时也跑一次 dummy scrypt，
// 抹平「未设密码（~0ms）vs 密码错（~100ms）」的时序侧信道（防枚举要连耗时一起防）。
const crypto = require('crypto');

// 当前默认参数（只可升，不可降）。N=16384,r=8,p=1 ≈ 16MB 内存 / ~100ms。
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 显式 64MB：N 翻倍到 32768 时需 33.5MB 不会抛错
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MIN_PASSWORD_LEN = 12;
const MAX_PASSWORD_LEN = 1024;

function hashPasswordSync(password, params = {}) {
  const N = params.N || SCRYPT_N;
  const r = params.r || SCRYPT_R;
  const p = params.p || SCRYPT_P;
  const salt = params.salt || crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(String(password), salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return null;
  let salt, hash;
  try {
    salt = Buffer.from(parts[4], 'base64');
    hash = Buffer.from(parts[5], 'base64');
  } catch { return null; }
  if (!salt.length || !hash.length) return null;
  return { N, r, p, salt, hash };
}

// 校验：恒定时间比较派生密钥。解析失败/长度不等一律 false（不抛错、不提前返回差异）。
function verifyPasswordSync(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LEN) return false;
  let derived;
  try {
    derived = crypto.scryptSync(String(password), parsed.salt, parsed.hash.length,
      { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: SCRYPT_MAXMEM });
  } catch { return false; }
  return derived.length === parsed.hash.length && crypto.timingSafeEqual(derived, parsed.hash);
}

// ---- 异步 KDF（请求路径用，r3/P1-3）----
function hashPassword(password, params = {}) {
  return new Promise((resolve, reject) => {
    const N = params.N || SCRYPT_N;
    const r = params.r || SCRYPT_R;
    const p = params.p || SCRYPT_P;
    const salt = params.salt || crypto.randomBytes(SALT_BYTES);
    crypto.scrypt(String(password), salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, hash) => {
      if (err) return reject(err);
      resolve(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const parsed = parseHash(stored);
    if (!parsed) return resolve(false);
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LEN) return resolve(false);
    crypto.scrypt(String(password), parsed.salt, parsed.hash.length,
      { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: SCRYPT_MAXMEM }, (err, derived) => {
        if (err) return resolve(false);
        resolve(derived.length === parsed.hash.length && crypto.timingSafeEqual(derived, parsed.hash));
      });
  });
}

// dummy 哈希（惰性生成一次）：未设密码时拿它跑一遍等价 scrypt，抹平时序差。
let _dummyHash = null;
function dummyHash() {
  if (!_dummyHash) _dummyHash = hashPasswordSync('diting-dummy-password-for-timing');
  return _dummyHash;
}

// 登录校验统一入口（r3/P1-4）：无论库中有无密码，都恰好执行一次 scrypt。
async function verifyPasswordEqualizing(password, stored) {
  if (!stored) {
    await verifyPassword(password, dummyHash());
    return false;
  }
  return verifyPassword(password, stored);
}

// 库中哈希参数是否弱于当前默认（登录成功后触发 rehash 升级）。
function needsRehash(stored) {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.N < SCRYPT_N || parsed.r < SCRYPT_R || parsed.p < SCRYPT_P;
}

// 密码强度（r3/P2-6 补弱口令形状）：长度 + 字符多样性 + 连续序列 + 可选禁用值
//（opts.reject：如调用方明文在手的 Admin Token，不得与之相同）。
// r5/P2-1：返回机器可读 reason（too_short/…），前端按码本地化；message 仅作兜底
//（硬编码中文，英文界面会露中文——故展示优先用 reason 映射）。
function checkPasswordStrength(pw, opts = {}) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LEN) {
    return { ok: false, reason: 'too_short', message: `密码至少 ${MIN_PASSWORD_LEN} 个字符` };
  }
  if (pw.length > MAX_PASSWORD_LEN) {
    return { ok: false, reason: 'too_long', message: `密码不能超过 ${MAX_PASSWORD_LEN} 个字符` };
  }
  if (/^\d+$/.test(pw)) {
    return { ok: false, reason: 'numeric', message: '密码不能为纯数字' };
  }
  if (new Set(pw).size <= 4) {
    return { ok: false, reason: 'low_variety', message: '密码字符种类过少，强度不足' };
  }
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf|zxcv)/i.test(pw)) {
    return { ok: false, reason: 'sequence', message: '密码含连续序列（如 1234/abcd），强度不足' };
  }
  if (opts.reject && pw === String(opts.reject)) {
    // reason 键名不得以 token 结尾（仓库卫生闸 H7 会误判 `xxx_token: '…'` 为凭据赋值）
    return { ok: false, reason: 'same_as_admin', message: '密码不能与管理员 Token 相同' };
  }
  return { ok: true };
}

// ---- 一次性恢复码（2FA 备份因子）----
// 格式 XXXX-XXXX-XXXX，Crockford base32 字符集（去 I/L/O/U 减少误读，r3/P2-4）；
// 规范形 = 去分隔符的 12 字符（输入侧把 I/L 归 1、O 归 0）。库中只存 sha256(规范形)，消费即删行。
const RECOVERY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    let raw = '';
    for (let j = 0; j < 12; j++) {
      raw += RECOVERY_CODE_ALPHABET[crypto.randomInt(RECOVERY_CODE_ALPHABET.length)];
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

function normalizeRecoveryCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1').replace(/O/g, '0');
  return new RegExp(`^[${RECOVERY_CODE_ALPHABET}]{12}$`).test(raw) ? raw : '';
}

function recoveryCodeHash(input) {
  const norm = normalizeRecoveryCode(input);
  if (!norm) return '';
  return crypto.createHash('sha256').update(norm).digest('hex');
}

module.exports = {
  SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_MAXMEM,
  MIN_PASSWORD_LEN, MAX_PASSWORD_LEN, RECOVERY_CODE_ALPHABET,
  hashPasswordSync, verifyPasswordSync, hashPassword, verifyPassword, verifyPasswordEqualizing,
  needsRehash, checkPasswordStrength,
  generateRecoveryCodes, normalizeRecoveryCode, recoveryCodeHash,
};
