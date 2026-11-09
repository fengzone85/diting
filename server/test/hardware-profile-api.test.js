'use strict';
// ============================================================
// 硬件档案 API 回归：录入 → 管理面回读 → 公开出口 / 全局开关
// 运行前提与 integration.api.test.js 相同：随机端口 + ADMIN_ALLOW_HTTP=1 + 独立临时库。
// ============================================================
process.env.PORT = '0';
process.env.ADMIN_ALLOW_HTTP = '1';
process.env.ADMIN_TOKEN = 'hardware-admin-token-0123456789abcdef';
process.env.PUBLIC_URL = 'https://monitor.example.test';
process.env.DB_PATH = `/tmp/diting-hardware-api-test-${process.pid}.db`;
// 禁服真实通知（仓库 .env 的 SMTP 占位符会激活邮件通道并真实联网）
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const request = require('supertest');

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 不存在则忽略 */ }
}

const { app, server } = require('../server');
const db = require('../src/db');

const ADMIN = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' };

after(() => {
  try { server.close(); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});

let agentId = '';

test('POST /api/agents 接受 hardware，GET 回读为解析对象', async () => {
  const res = await request(app)
    .post('/api/agents')
    .set(ADMIN)
    .send({
      name: 'hw-api',
      hardware: {
        cpu: { src: 'enum', vendor: 'Intel', tag: '第11代', hidden: false },
        arch: { src: 'custom', text: 'x86_64', hidden: false },
        virt: { src: 'enum', value: 'KVM', hidden: true },
        gpu: { src: 'enum', value: '核显', hidden: false },
        kernel: { src: 'custom', text: '6.1.0-18-amd64', hidden: false }
      }
    });
  assert.strictEqual(res.status, 200);
  agentId = res.body.id;

  const got = await request(app).get(`/api/agents/${agentId}`).set(ADMIN);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.body.hardware.cpu.vendor, 'Intel');
  assert.strictEqual(got.body.hardware.cpu.tag, '第11代');
  assert.strictEqual(got.body.hardware.virt.hidden, true);
  assert.strictEqual(got.body.hardware.kernel.text, '6.1.0-18-amd64');
});

test('GET /api/hardware-options 返回候选清单', async () => {
  const res = await request(app).get('/api/hardware-options').set(ADMIN);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.cpu_vendors.includes('Intel'));
  assert.ok(res.body.cpu_tags_by_vendor.Intel.includes('第11代'));
  assert.deepStrictEqual(res.body.gpu_types, ['核显', '独显']);
});

test('PUT 非法枚举 → 400；合法更新生效；未携带 hardware 时保留原值', async () => {
  const bad = await request(app)
    .put(`/api/agents/${agentId}`)
    .set(ADMIN)
    .send({ name: 'hw-api', hardware: { arch: { src: 'enum', value: 'sparc' } }, merchant: 'm' });
  assert.strictEqual(bad.status, 400);

  // 合法更新：改为手填 + 不公开
  const good = await request(app)
    .put(`/api/agents/${agentId}`)
    .set(ADMIN)
    .send({
      name: 'hw-api',
      merchant: 'm',
      hardware: { cpu: { src: 'custom', text: 'AMD EPYC 7B13', hidden: true } }
    });
  assert.strictEqual(good.status, 200);
  let row = db.getAgent(agentId);
  assert.strictEqual(JSON.parse(row.hw_profile).cpu.text, 'AMD EPYC 7B13');

  // 不携带 hardware 的局部更新（例如脚本只改商家）不得抹掉档案
  const partial = await request(app)
    .put(`/api/agents/${agentId}`)
    .set(ADMIN)
    .send({ name: 'hw-api', merchant: 'prov-y' });
  assert.strictEqual(partial.status, 200);
  row = db.getAgent(agentId);
  assert.strictEqual(row.merchant, 'prov-y');
  assert.strictEqual(JSON.parse(row.hw_profile).cpu.text, 'AMD EPYC 7B13');
});

test('公开出口：cpu_name 合成、hidden 不输出、GPU 空值 None', async () => {
  // 放开隐藏，便于断言合成值
  await request(app)
    .put(`/api/agents/${agentId}`)
    .set(ADMIN)
    .send({
      name: 'hw-api',
      merchant: 'prov-y',
      hardware: {
        cpu: { src: 'enum', vendor: 'Intel', tag: '第12代', hidden: false },
        arch: { src: 'enum', value: 'x86_64', hidden: false },
        virt: { src: 'enum', value: 'LXC', hidden: false },
        kernel: { src: 'custom', text: '6.1.0-18-amd64', hidden: false }
      }
    });

  const compatRes = await request(app).get('/api/nodes');
  assert.strictEqual(compatRes.status, 200);
  const node = compatRes.body.data.find((n) => n.uuid === agentId);
  assert.strictEqual(node.cpu_name, 'Intel 第12代');
  assert.strictEqual(node.arch, 'x86_64');
  assert.strictEqual(node.virtualization, 'LXC');
  assert.strictEqual(node.gpu_name, 'None');
  assert.strictEqual(node.kernel_version, '6.1.0-18-amd64');

  const v1Res = await request(app).get('/api/v1/nodes');
  assert.strictEqual(v1Res.status, 200);
  const v1Node = v1Res.body.data.find((n) => n.uuid === agentId);
  assert.strictEqual(v1Node.cpu_name, 'Intel 第12代');
  assert.strictEqual(v1Node.kernel, '6.1.0-18-amd64');

  const pubRes = await request(app).get('/api/public/agents');
  assert.strictEqual(pubRes.status, 200);
  const pub = pubRes.body.find((n) => n.id === agentId);
  assert.strictEqual(pub.cpu_name, 'Intel 第12代');
  assert.strictEqual(pub.gpu_name, '');
  assert.strictEqual(pub.kernel_version, '6.1.0-18-amd64');
});

test('全局开关关闭：公开出口统一空值，管理面仍可见', async () => {
  const before = db.getUiSettings();
  db.setUiSettings(Object.assign({}, before, { public_show_hardware: false }));
  try {
    const compatRes = await request(app).get('/api/nodes');
    const node = compatRes.body.data.find((n) => n.uuid === agentId);
    assert.strictEqual(node.cpu_name, '');
    assert.strictEqual(node.arch, '');
    assert.strictEqual(node.virtualization, '');
    assert.strictEqual(node.gpu_name, 'None');
    assert.strictEqual(node.kernel_version, '');

    const v1Res = await request(app).get('/api/v1/nodes');
    const v1Node = v1Res.body.data.find((n) => n.uuid === agentId);
    assert.strictEqual(v1Node.cpu_name, null);
    assert.strictEqual(v1Node.arch, null);
    assert.strictEqual(v1Node.kernel, null);

    const adminRes = await request(app).get(`/api/agents/${agentId}`).set(ADMIN);
    assert.strictEqual(adminRes.body.hardware.cpu.vendor, 'Intel');
  } finally {
    db.setUiSettings(before);
  }
});
