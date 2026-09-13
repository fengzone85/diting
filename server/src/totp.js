'use strict';
// RFC 6238 TOTP (HMAC-SHA1, base32 secret), zero-dependency.
// Reference test vectors verified against RFC 6238 / RFC 4226.
const crypto = require('crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s) {
  s = String(s).replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = '';
  for (const c of s) {
    const v = BASE32.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  }
  const rem = bits.length % 5;
  if (rem) out += BASE32[parseInt(bits.slice(-rem).padEnd(5, '0'), 2)];
  return out;
}

function hotp(secretBase32, counter, digits = 6) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

function totp(secretBase32, opts = {}) {
  const { digits = 6, period = 30, timestamp = Date.now() } = opts;
  const counter = Math.floor(timestamp / 1000 / period);
  return hotp(secretBase32, counter, digits);
}

// 返回匹配的 counter（number）或 null。
// 供重放防护使用：调用方需要拿到「命中的时间步」做已消费记账，
// 故从 verifyTOTP 中抽出核心逻辑（verifyTOTP 保留为薄封装，兼容旧调用点）。
function matchCounter(secretBase32, code, opts = {}) {
  const { digits = 6, period = 30, window = 1, timestamp = Date.now() } = opts;
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d+$/.test(code)) return null;
  const counter = Math.floor(timestamp / 1000 / period);
  for (let i = -window; i <= window; i++) {
    const c = counter + i;
    if (hotp(secretBase32, c, digits) === code) return { counter: c, period };
  }
  return null;
}

function verifyTOTP(secretBase32, code, opts = {}) {
  return matchCounter(secretBase32, code, opts) !== null;
}

function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function otpauthUri(secretBase32, account = 'admin', issuer = 'HostMonitor') {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  const params = new URLSearchParams({
    secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30',
  });
  return 'otpauth://totp/' + label + '?' + params.toString();
}

module.exports = { generateSecret, totp, verifyTOTP, matchCounter, otpauthUri, base32Encode, base32Decode };
