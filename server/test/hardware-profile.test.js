'use strict';
// ============================================================
// 硬件档案回归：管理员手工录入的 CPU / 架构 / 虚拟化 / GPU
// 方案：plans/2026-10-26-komari-compat-fields.md §4（2026-11-09 更新为单列 JSON）
//
// 安全前提：受控端不自动采集硬件指纹；本文件验证
//   1. 归一化：预设枚举、手填校验、隐藏标记
//   2. arch 从 agent_platform 派生（零采集）
//   3. 公开出口：字段隐藏 / 全局开关关闭时输出空值，GPU 用 'None'
//   4. compat / v1 / 数据库 round-trip 与局部更新不丢档案
// ============================================================
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const hardware = require('../src/hardware-profile');
const compat = require('../src/compat');
const v1 = require('../src/v1');

function mkAgent(fields) {
  const { id } = db.createAgent(fields || {});
  return db.getAgent(id);
}

function setProfile(agent, profile) {
  const row = db.getAgent(agent.id);
  db.updateAgent(agent.id, Object.assign({}, row, { hw_profile: JSON.stringify(profile) }));
  return db.getAgent(agent.id);
}

test('normalizeProfile：预设 CPU 合成「厂商 + 代际」', () => {
  const r = hardware.normalizeProfile({ cpu: { src: 'enum', vendor: 'Intel', tag: '第11代' } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value.cpu, { src: 'enum', vendor: 'Intel', tag: '第11代', hidden: false });
  assert.strictEqual(hardware.composeCpuName(r.value.cpu), 'Intel 第11代');
});

test('normalizeProfile：手填文本 trim、可隐藏、可精确型号', () => {
  const r = hardware.normalizeProfile({
    cpu: { src: 'custom', text: '  AMD EPYC 7B13  ', hidden: true },
    gpu: { src: 'enum', value: '独显' }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.cpu.text, 'AMD EPYC 7B13');
  assert.strictEqual(r.value.cpu.hidden, true);
  assert.strictEqual(r.value.gpu.value, '独显');
});

test('normalizeProfile：非法枚举 / 超长文本 / 尖括号 / 控制字符一律拒绝', () => {
  assert.strictEqual(hardware.normalizeProfile({ cpu: { src: 'enum', vendor: 'VIA' } }).ok, false);
  assert.strictEqual(hardware.normalizeProfile({ cpu: { src: 'enum', vendor: 'Intel', tag: '第99代' } }).ok, false);
  assert.strictEqual(hardware.normalizeProfile({ arch: { src: 'enum', value: 'sparc' } }).ok, false);
  assert.strictEqual(hardware.normalizeProfile({ virt: { src: 'custom', text: '<script>' } }).ok, false);
  assert.strictEqual(hardware.normalizeProfile({ arch: { src: 'custom', text: 'x'.repeat(33) } }).ok, false);
  assert.strictEqual(hardware.normalizeProfile({ bad: 1, cpu: { src: 'nope' } }).ok, false);
  // 控制字符是被剔除而不是报错
  const cleaned = hardware.normalizeProfile({ arch: { src: 'custom', text: 'x\u0001y' } });
  assert.strictEqual(cleaned.ok, true);
  assert.strictEqual(cleaned.value.arch.text, 'xy');
});

test('normalizeProfile：空值字段被省略（未填写 ≠ 报错）', () => {
  const r = hardware.normalizeProfile({
    cpu: { src: 'enum', vendor: '' },
    arch: { src: 'custom', text: '   ' },
    virt: { src: 'enum', value: '' }
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, {});
});

test('normalizeProfile：隐藏态允许不选值（压住 arch 派生）', () => {
  const r = hardware.normalizeProfile({ arch: { src: 'enum', hidden: true }, gpu: { src: 'custom', hidden: true } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value.arch, { src: 'enum', hidden: true });
  const f = hardware.publicFields(
    { agent_platform: 'linux-amd64', hw_profile: JSON.stringify(r.value) },
    true
  );
  assert.strictEqual(f.arch, '');
  assert.strictEqual(f.gpu_name, '');
});

test('normalizeProfile：内核版本只接受手填（无预设档位）', () => {
  const r = hardware.normalizeProfile({ kernel: { src: 'custom', text: ' 6.1.0-18-amd64 ' } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value.kernel, { src: 'custom', text: '6.1.0-18-amd64', hidden: false });

  const hidden = hardware.normalizeProfile({ kernel: { src: 'custom', hidden: true } });
  assert.deepStrictEqual(hidden.value.kernel, { src: 'custom', hidden: true });

  // 内核版本不允许预设枚举，避免 pseudo-precise 的假档位
  assert.strictEqual(hardware.normalizeProfile({ kernel: { src: 'enum', value: '6.1' } }).ok, false);
  assert.strictEqual(hardware.normalizeProfile({ kernel: { src: 'custom', text: '<6.1>' } }).ok, false);
  assert.strictEqual(hardware.normalizeProfile({ kernel: { src: 'custom', text: 'x'.repeat(33) } }).ok, false);
});

test('publicFields：内核版本随字段隐藏 / 全局开关输出空值', () => {
  const profile = { kernel: { src: 'custom', text: '6.1.0-18-amd64', hidden: false } };
  const visible = hardware.publicFields({ hw_profile: JSON.stringify(profile) }, true);
  assert.strictEqual(visible.kernel_version, '6.1.0-18-amd64');

  const hidden = hardware.publicFields(
    { hw_profile: JSON.stringify({ kernel: { src: 'custom', text: '6.1.0-18-amd64', hidden: true } }) },
    true
  );
  assert.strictEqual(hidden.kernel_version, '');

  const off = hardware.publicFields({ hw_profile: JSON.stringify(profile) }, false);
  assert.strictEqual(off.kernel_version, '');
});

test('parseProfile：损坏 JSON 按未填写处理，不影响节点列表', () => {
  assert.deepStrictEqual(hardware.parseProfile('{bad json'), {});
  assert.deepStrictEqual(hardware.parseProfile(''), {});
});

test('deriveArch：构建目标 → 架构名（零采集）', () => {
  assert.strictEqual(hardware.deriveArch('linux-amd64'), 'x86_64');
  assert.strictEqual(hardware.deriveArch('windows-amd64'), 'x86_64');
  assert.strictEqual(hardware.deriveArch('linux-arm64'), 'aarch64');
  assert.strictEqual(hardware.deriveArch('linux-loong64'), 'loongarch64');
  assert.strictEqual(hardware.deriveArch('amd64'), '');
  assert.strictEqual(hardware.deriveArch(''), '');
});

test('publicFields：隐藏字段不输出，未填 arch 走派生', () => {
  const a = {
    agent_platform: 'linux-amd64',
    hw_profile: JSON.stringify({
      cpu: { src: 'enum', vendor: 'AMD', tag: 'Zen 3', hidden: true },
      arch: { src: 'enum', value: 'x86_64', hidden: true },
      virt: { src: 'custom', text: 'KVM' }
    })
  };
  const f = hardware.publicFields(a, true);
  assert.strictEqual(f.cpu_name, '');
  assert.strictEqual(f.arch, ''); // 字段 hidden 时不回退派生
  assert.strictEqual(f.virtualization, 'KVM');
  assert.strictEqual(f.gpu_name, '');
});

test('publicFields：全局开关关闭时全部为空', () => {
  const a = {
    agent_platform: 'linux-amd64',
    hw_profile: JSON.stringify({ cpu: { src: 'custom', text: 'Intel i5' }, gpu: { src: 'enum', value: '核显' } })
  };
  const f = hardware.publicFields(a, false);
  assert.deepStrictEqual(f, { cpu_name: '', arch: '', virtualization: '', gpu_name: '', kernel_version: '' });
});

test('DB round-trip：创建/更新写入档案，局部更新不抹掉', () => {
  const a = mkAgent({ name: 'hw-db' });
  const row = setProfile(a, { virt: { src: 'enum', value: 'Docker', hidden: false } });
  assert.strictEqual(JSON.parse(row.hw_profile).virt.value, 'Docker');

  // 不携带 hw_profile 的更新（模拟设置页/其它局部更新）必须保留原值
  db.updateAgent(a.id, Object.assign({}, db.getAgent(a.id), { merchant: 'prov-x' }));
  const after = db.getAgent(a.id);
  assert.strictEqual(JSON.parse(after.hw_profile).virt.value, 'Docker');
  assert.strictEqual(after.merchant, 'prov-x');
});

test('compat.toNode：字段映射、GPU 占位与全局开关', () => {
  const a = mkAgent({ name: 'hw-compat' });
  db.setAgentBuild(a.id, 'abcdef1', '2026-11-09T00:00:00Z', 'linux-arm64');
  const row = setProfile(a, {
    cpu: { src: 'enum', vendor: 'Apple', tag: 'M2' },
    virt: { src: 'enum', value: 'LXC' },
    gpu: { src: 'custom', text: '核显' }
  });

  const n = compat.toNode(row, true, undefined, undefined, true);
  assert.strictEqual(n.cpu_name, 'Apple M2');
  assert.strictEqual(n.arch, 'aarch64');
  assert.strictEqual(n.virtualization, 'LXC');
  assert.strictEqual(n.gpu_name, '核显');
  assert.strictEqual(n.kernel_version, '');

  // 未填写 GPU → Komari 约定 'None'（主题整行隐藏）
  const noGpu = setProfile(a, { cpu: { src: 'enum', vendor: 'Intel' } });
  assert.strictEqual(compat.toNode(noGpu, true, undefined, undefined, true).gpu_name, 'None');

  // 全局开关关闭：所有公开出口统一空值
  const before = db.getUiSettings();
  db.setUiSettings(Object.assign({}, before, { public_show_hardware: false }));
  try {
    const off = compat.toNode(db.getAgent(a.id), true);
    assert.strictEqual(off.cpu_name, '');
    assert.strictEqual(off.arch, '');
    assert.strictEqual(off.virtualization, '');
    assert.strictEqual(off.gpu_name, 'None');
  } finally {
    db.setUiSettings(before);
  }
});

test('compat / v1：内核版本映射（未填为空 / null）', () => {
  const a = mkAgent({ name: 'hw-kernel' });
  const row = setProfile(a, { kernel: { src: 'custom', text: '6.1.0-18-amd64' } });
  assert.strictEqual(compat.toNode(row, true, undefined, undefined, true).kernel_version, '6.1.0-18-amd64');
  assert.strictEqual(v1.toNode(row, true, undefined, true).kernel, '6.1.0-18-amd64');

  const empty = mkAgent({ name: 'hw-kernel-empty' });
  assert.strictEqual(compat.toNode(empty, true, undefined, undefined, true).kernel_version, '');
  assert.strictEqual(v1.toNode(empty, true, undefined, true).kernel, null);
});

test('v1.toNode / CAPABILITY：标准字段与能力声明同步', () => {
  const a = mkAgent({ name: 'hw-v1' });
  db.setAgentBuild(a.id, '', '', 'windows-amd64');
  const row = setProfile(a, { arch: { src: 'custom', text: 'x86' } });
  const n = v1.toNode(row, true, undefined, true);
  assert.strictEqual(n.arch, 'x86');
  assert.strictEqual(n.kernel, null);
  assert.strictEqual(n.cpu_name, null);
  assert.strictEqual(n.virtualization, null);
  assert.strictEqual(n.gpu.model, null);

  assert.strictEqual(v1.CAPABILITY.cpu_name, true);
  assert.strictEqual(v1.CAPABILITY.arch, true);
  assert.strictEqual(v1.CAPABILITY.virtualization, true);
  // gpu 能力位指「GPU 使用率采集」，不是名称字段 → 必须保持 false
  assert.strictEqual(v1.CAPABILITY.gpu, false);
});

test('options：候选清单单一事实源', () => {
  const o = hardware.options();
  assert.ok(o.cpu_vendors.includes('Intel'));
  assert.ok(o.cpu_tags_by_vendor.Intel.includes('第11代'));
  assert.ok(o.archs.includes('x86_64'));
  assert.ok(o.virtualizations.includes('KVM'));
  assert.deepStrictEqual(o.gpu_types, ['核显', '独显']);
  assert.strictEqual(o.max_text_length, 32);
});
