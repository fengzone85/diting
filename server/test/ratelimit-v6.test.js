'use strict';
// S4：限流维度 IPv6 /64 归桶（bucketKey）。
// 核心威胁：IPv6 接口 ID 可任意变换，按完整地址计数时攻击者换个地址就是「新 IP」，
// 配额形同虚设。同一 /64 视为同一来源。
process.env.PORT = '0';

const { test } = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
process.env.DB_PATH = '/tmp/diting-ratelimit-v6-test.db';
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const { bucketKey, rateLimitTouch, loginGuard, loginGuardFail, loginGuardClear, _loginGuardState } = require('../src/ratelimit');
const { ip6ToBits } = require('../src/util');
const db = require('../src/db');

test('S4 bucketKey：IPv4 原样；::ffff: 壳剥成 IPv4（否则点分四段会进错桶）', () => {
  assert.strictEqual(bucketKey('1.2.3.4'), '1.2.3.4');
  assert.strictEqual(bucketKey('192.168.0.1'), '192.168.0.1');
  // Express 对 v4-mapped 连接返回的正是这种形式
  assert.strictEqual(bucketKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.strictEqual(bucketKey('::ffff:192.168.0.1'), '192.168.0.1');
  // ::ffff:c0a8:1 十六进制形式同样归一
  assert.strictEqual(bucketKey('::ffff:c0a8:1'), '192.168.0.1');
});

test('S4 bucketKey：同 /64 同桶、跨 /64 不同桶', () => {
  assert.strictEqual(bucketKey('2001:db8::1'), bucketKey('2001:db8:0:0::5'));
  assert.notStrictEqual(bucketKey('2001:db8::1'), bucketKey('2001:db8:0:1::1'));
  // 环回与链路本地（带 zone id）也归到各自的 /64
  assert.strictEqual(bucketKey('::1'), '0000:0000:0000:0000::/64');
  assert.strictEqual(bucketKey('fe80::1%eth0'), 'fe80:0000:0000:0000::/64');
  // 括号形式（代理层常见）
  assert.strictEqual(bucketKey('[2001:db8::1]'), bucketKey('2001:db8::1'));
});

test('S4 bucketKey：非法输入退化为原值，绝不放大成整网误伤', () => {
  assert.strictEqual(bucketKey('not-an-ip'), 'not-an-ip');
  assert.strictEqual(bucketKey(''), 'unknown');
  assert.strictEqual(bucketKey(undefined), 'unknown');
  // 三段以上 '::' 非法：ip6ToBits 返回 null → 原值
  assert.strictEqual(bucketKey('1::2::3'), '1::2::3');
});

test('S4 ip6ToBits：压缩格式展开与 IPv4 返回 null', () => {
  assert.strictEqual(ip6ToBits('2001:db8::1'), (0x20010db8n << 96n) | 1n);
  assert.strictEqual(ip6ToBits('1.2.3.4'), null, 'IPv4 不是 IPv6，应返回 null');
  assert.strictEqual(ip6ToBits('gggg::1'), null);
});

test('S4 限流共享配额：同一 /64 两个地址只算一份', () => {
  const map = new Map();
  const MAX = 2;
  assert.strictEqual(rateLimitTouch(map, bucketKey('2001:db8::a'), 1000, MAX), true);
  // 换个接口 ID：仍是同一个桶，第 2 次放行、第 3 次拦截
  assert.strictEqual(rateLimitTouch(map, bucketKey('2001:db8:0:0:1:2:3:4'), 1000, MAX), true);
  assert.strictEqual(rateLimitTouch(map, bucketKey('2001:db8::ffff'), 1000, MAX), false, '同 /64 应共享配额');

  const other = new Map();
  assert.strictEqual(rateLimitTouch(other, bucketKey('2001:db8:1::1'), 1000, MAX), true, '不同 /64 互不影响');
});

test('S4 封禁共享：同 /64 换地址绕不过指数封禁', () => {
  _loginGuardState.clear();
  const keyA = bucketKey('2001:db8::a');
  const keyB = bucketKey('2001:db8:0:0:5:6:7:8');
  assert.strictEqual(keyA, keyB, '同一 /64 归桶后 key 相同');

  // 第 1、2 次失败只累计；第 3 次触发封禁
  assert.strictEqual(loginGuardFail(keyA).banned, false);
  assert.strictEqual(loginGuardFail(keyA).banned, false);
  const r = loginGuardFail(keyA);
  assert.strictEqual(r.banned, true, '第 3 次失败应触发封禁');
  assert.ok(r.retryAfterSec > 0);

  const g = loginGuard(keyB);
  assert.strictEqual(g.allowed, false, '同 /64 的另一地址应同样处于封禁期');

  loginGuardClear(keyA);
  assert.strictEqual(loginGuard(keyB).allowed, true, '登录成功后封禁解除');
  _loginGuardState.clear();
});

test('S4 IP 白名单不受影响：仍按完整地址/前缀精确匹配', () => {
  const { ipWhitelist } = require('../src/auth');
  const base = db.getUiSettings();
  db.setUiSettings(Object.assign({}, base, { admin_allow_ips: '2001:db8::/32' }));
  try {
    const mk = (ip) => ({ ip, socket: { remoteAddress: ip }, path: '/', headers: {} });
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
    let next = 0;
    ipWhitelist(mk('2001:db8::1234'), res, () => { next++; });
    assert.strictEqual(next, 1, '白名单内的具体地址应放行');
    next = 0;
    ipWhitelist(mk('2001:db9::1234'), res, () => { next++; });
    assert.strictEqual(next, 0, '不在前缀内应被拦（归桶不应用于白名单）');
  } finally {
    db.setUiSettings(base);
  }
});
