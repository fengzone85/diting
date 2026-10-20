'use strict';
// ============================================================
// S1/F2：Webhook 出站 SSRF 防护（默认拒绝路径）
//
// 本文件刻意不设置 ALLOW_PRIVATE_WEBHOOK / ALLOW_INSECURE_WEBHOOK，
// 验证「安全默认」：私网/回环/保留段、明文 http 均被拒绝。
// 放行内网自托管场景的端到端投递见 notify.test.js。
// ============================================================
process.env.DB_PATH = '/tmp/diting-notify-ssrf.db';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
delete process.env.ALLOW_PRIVATE_WEBHOOK;
delete process.env.ALLOW_INSECURE_WEBHOOK;

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
}

const db = require('../src/db');
const notify = require('../src/notify');
const { validateWebhookConfig } = require('../src/validate');
const { isBlockedIP, parseTarget } = notify._internal;

after(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

// ---- 1. IP 段判定 ----------------------------------------------------------

test('isBlockedIP：私网/回环/链路本地/保留段全部拒绝', () => {
  const blocked = [
    '0.0.0.0', '10.0.0.1', '10.255.255.254', '127.0.0.1', '127.8.8.8',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.7',
    '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '64:ff9b::1'
  ];
  for (const ip of blocked) assert.strictEqual(isBlockedIP(ip), true, `${ip} 应被拒绝`);

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'];
  for (const ip of allowed) assert.strictEqual(isBlockedIP(ip), false, `${ip} 应放行`);
});

test('isBlockedIP：非法字符串按拒绝处理（fail-closed）', () => {
  for (const v of ['', 'not-an-ip', '999.1.1.1', '1.2.3', '::gg']) {
    assert.strictEqual(isBlockedIP(v), true);
  }
});

// ---- 2. 协议与目标解析 ------------------------------------------------------

test('parseTarget：默认拒绝明文 http', () => {
  assert.throws(() => parseTarget('http://example.com/hook', {}), /insecure_scheme/);
  assert.throws(() => parseTarget('ftp://example.com/hook', {}), /scheme_invalid/);
  assert.throws(() => parseTarget('not a url', {}), /url_invalid/);
  const t = parseTarget('https://example.com/hook?a=1', { method: 'get' });
  assert.strictEqual(t.port, 443);
  assert.strictEqual(t.method, 'GET');
  assert.strictEqual(t.path, '/hook?a=1');
});

test('testChannel：https 指向回环地址默认被拒绝（blocked_target），且不发起连接', async () => {
  const ch = db.createNotifyChannel({
    type: 'webhook',
    name: 'ssrf-loopback',
    config: { url: 'https://127.0.0.1:1/hook', method: 'POST', content_type: 'json', headers: {}, body_template: '', verify_tls: true }
  });
  await assert.rejects(() => notify.testChannel(ch.id), /blocked_target/);
});

// ---- 3. 头注入防护 ----------------------------------------------------------

test('validateWebhookConfig：禁止覆盖 Host/Content-Length/Connection/Transfer-Encoding', () => {
  const v = validateWebhookConfig({
    url: 'https://example.com/hook',
    method: 'POST',
    content_type: 'json',
    headers: {
      Host: 'evil.example',
      'Content-Length': '99999',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
      Expect: '100-continue',
      'X-Good': '1',
      'bad header': 'x',
      'X-Long': 'a'.repeat(600)
    },
    body_template: '{"t":"{{title}}"}'
  });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.config.headers, { 'X-Good': '1' });
});

test('validateWebhookConfig：非法 URL/方法/类型被拒绝；模板长度受限', () => {
  assert.strictEqual(validateWebhookConfig({ url: 'ftp://x' }).ok, false);
  assert.strictEqual(validateWebhookConfig({ url: 'https://x', method: 'PUT' }).ok, false);
  assert.strictEqual(validateWebhookConfig({ url: 'https://x', content_type: 'xml' }).ok, false);
  const v = validateWebhookConfig({ url: 'https://x', body_template: 'a'.repeat(20000) });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.config.body_template.length, 8000);
});
