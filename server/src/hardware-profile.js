'use strict';
// 管理员手工录入的硬件/系统档案 —— 对齐 Komari 节点的 cpu_name / arch / virtualization / gpu_name / kernel_version
//
// 安全口径（README.md / docs/security.md 同步）：
//   - 受控端**不自动采集**任何个体级硬件指纹；本模块只做「管理员手填值的校验与合成」。
//   - 默认粒度切在「厂商 + 代际」：同一分组可能横跨多个微架构，「同分组 = 同漏洞面」不成立。
//   - 管理员可自愿「手填」任意文本（≤32 字符），等同于自愿公开；「隐藏」只影响公开出口。
//   - 内核版本没有「代际」粒度：只支持手填 / 不填 / 隐藏，且它可直接匹配 CVE，属最高敏感项。
//   - 全局开关 ui_settings.public_show_hardware 关闭时，所有公开出口一律输出空值。
//
// 存储：agents.hw_profile 单列 JSON（'' / '{}' = 未填写）。
// {
//   "cpu":    { "src": "enum",   "vendor": "Intel", "tag": "第11代", "hidden": true },
//   "arch":   { "src": "custom", "text": "x86_64", "hidden": false },
//   "virt":   { "src": "enum",   "value": "KVM", "hidden": false },
//   "gpu":    { "src": "enum",   "value": "核显", "hidden": false },
//   "kernel": { "src": "custom", "text": "6.1.0-18-amd64", "hidden": false }
// }
//
// 四态语义：字段不存在 = 未设置；src=enum = 预设；src=custom = 手填；
// hidden=true = 值保留在库中供管理面查看，但公开出口不输出。

const CPU_VENDORS = ['Intel', 'AMD', 'Apple', '其他'];

// 代际级标签（不含精确型号）。Intel 第 3–15 代横跨多个微架构，故不指向具体漏洞配方。
const CPU_TAGS_BY_VENDOR = {
  Intel: [
    '第3代', '第4代', '第5代', '第6代', '第7代', '第8代',
    '第9代', '第10代', '第11代', '第12代', '第13代', '第14代', '第15代'
  ],
  AMD: ['Zen', 'Zen+', 'Zen 2', 'Zen 3', 'Zen 4', 'Zen 5'],
  Apple: ['M1', 'M2', 'M3', 'M4'],
  其他: []
};

const ARCHS = ['x86_64', 'x86', 'aarch64', 'arm', 'riscv64', 'loongarch64', '其他'];
const VIRTUALIZATIONS = ['物理机', 'KVM', 'VMware', 'Hyper-V', 'LXC', 'Docker', '其他'];
// GPU 只到「核显 / 独显」类目：型号是最高价值的个体级指纹（算力特征 + 驱动 CVE 面），
// 且 diting 没有 GPU 使用率数据源，填了也只有名称没有曲线。
const GPU_TYPES = ['核显', '独显'];

const FIELD_KEYS = ['cpu', 'arch', 'virt', 'gpu', 'kernel'];
const MAX_TEXT = 32;
const MAX_JSON = 2048;

// 手填文本最小校验：去控制字符、限长、拒绝尖括号（未知社区主题可能用 innerHTML 渲染）。
function normalizeText(v) {
  // 逐字符剔除控制字符（C0 + DEL）；不用正则字面量，避免 eslint no-control-regex。
  const s = Array.from(String(v == null ? '' : v))
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c > 0x1f && c !== 0x7f;
    })
    .join('')
    .trim();
  if (!s) return '';
  if (s.length > MAX_TEXT) return null;
  if (/[<>]/.test(s)) return null;
  return s;
}

function normalizeField(key, v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `invalid_${key}` };
  const src = v.src;
  if (src !== 'enum' && src !== 'custom') return { ok: false, error: `invalid_${key}_src` };
  const hidden = v.hidden === true;
  // 「隐藏」允许只存 hidden 不选值：arch 的空隐藏还要能压住 agent_platform 派生。
  const hiddenOnly = () => ({ ok: true, value: { src, hidden: true } });
  const empty = () => (hidden ? hiddenOnly() : { ok: true, value: null });

  if (key === 'cpu') {
    if (src === 'custom') {
      const text = normalizeText(v.text);
      if (text === null) return { ok: false, error: 'invalid_cpu_text' };
      if (!text) return empty();
      return { ok: true, value: { src, text, hidden } };
    }
    const vendor = String(v.vendor == null ? '' : v.vendor).trim();
    if (!vendor) return empty();
    if (!CPU_VENDORS.includes(vendor)) return { ok: false, error: 'invalid_cpu_vendor' };
    const tag = String(v.tag == null ? '' : v.tag).trim();
    if (tag && !(CPU_TAGS_BY_VENDOR[vendor] || []).includes(tag)) return { ok: false, error: 'invalid_cpu_tag' };
    return { ok: true, value: { src, vendor, tag, hidden } };
  }

  // 内核版本没有「代际」粒度：只接受手填，不接受预设（避免给出 pseudo-precise 的假档位）。
  if (key === 'kernel') {
    if (src !== 'custom') return { ok: false, error: 'invalid_kernel_src' };
    const text = normalizeText(v.text);
    if (text === null) return { ok: false, error: 'invalid_kernel_text' };
    if (!text) return empty();
    return { ok: true, value: { src: 'custom', text, hidden } };
  }

  const list = key === 'arch' ? ARCHS : key === 'virt' ? VIRTUALIZATIONS : GPU_TYPES;
  if (src === 'custom') {
    const text = normalizeText(v.text);
    if (text === null) return { ok: false, error: `invalid_${key}_text` };
    if (!text) return empty();
    return { ok: true, value: { src, text, hidden } };
  }
  const value = String(v.value == null ? '' : v.value).trim();
  if (!value) return empty();
  if (!list.includes(value)) return { ok: false, error: `invalid_${key}_value` };
  return { ok: true, value: { src, value, hidden } };
}

// 入参可为 JSON 字符串（来自 DB / API）或对象。
// 返回 { ok: true, value } | { ok: false, error }；空值字段被省略（不写空对象）。
function normalizeProfile(input) {
  let o = input;
  if (typeof o === 'string') {
    if (!o.trim()) return { ok: true, value: {} };
    if (o.length > MAX_JSON) return { ok: false, error: 'hardware_profile_too_large' };
    try { o = JSON.parse(o); } catch { return { ok: false, error: 'invalid_hardware_profile' }; }
  }
  if (o == null) return { ok: true, value: {} };
  if (typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'invalid_hardware_profile' };

  const out = {};
  for (const key of FIELD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(o, key)) continue;
    const r = normalizeField(key, o[key]);
    if (!r.ok) return r;
    if (r.value) out[key] = r.value;
  }
  return { ok: true, value: out };
}

// 读路径：库里的值理应已归一化；异常/老数据一律按「未填写」处理，绝不因档案损坏影响节点列表。
function parseProfile(raw) {
  const r = normalizeProfile(raw);
  return r.ok ? r.value : {};
}

function composeCpuName(cpu) {
  if (!cpu) return '';
  if (cpu.src === 'custom') return cpu.text || '';
  if (!cpu.vendor) return '';
  return cpu.tag ? `${cpu.vendor} ${cpu.tag}` : cpu.vendor;
}

// agent_platform 是受控端构建目标（linux-amd64 / windows-amd64 …），不是硬件探测值。
// 语义：agent 二进制架构 ≈ 系统架构；管理员手填值优先（可纠正 32 位用户态跑 64 位 agent 等偏差）。
const GOARCH_TO_ARCH = {
  amd64: 'x86_64',
  '386': 'x86',
  arm64: 'aarch64',
  arm: 'arm',
  riscv64: 'riscv64',
  loong64: 'loongarch64',
  mips: 'mips',
  mipsle: 'mipsle',
  mips64: 'mips64',
  mips64le: 'mips64le',
  ppc64: 'ppc64',
  ppc64le: 'ppc64le',
  s390x: 's390x'
};

function deriveArch(platform) {
  const parts = String(platform || '').toLowerCase().split('-');
  if (parts.length < 2) return '';
  return GOARCH_TO_ARCH[parts[1]] || '';
}

// 公开出口统一合成。showHardware=false（全局开关关闭）时全部为空；GPU 用 '' 表示「无/隐藏」，
// 由调用方决定是否回退成 Komari 的 'None' 占位。
function publicFields(agent, showHardware) {
  const p = parseProfile(agent && agent.hw_profile);
  const visible = showHardware !== false;

  let cpuName = '';
  if (visible && p.cpu && !p.cpu.hidden) cpuName = composeCpuName(p.cpu);

  let arch = '';
  if (p.arch) {
    if (visible && !p.arch.hidden) arch = p.arch.src === 'custom' ? p.arch.text : p.arch.value;
  } else if (visible) {
    arch = deriveArch(agent && agent.agent_platform);
  }

  let virtualization = '';
  if (visible && p.virt && !p.virt.hidden) {
    virtualization = p.virt.src === 'custom' ? p.virt.text : p.virt.value;
  }

  let gpuName = '';
  if (visible && p.gpu && !p.gpu.hidden) gpuName = p.gpu.src === 'custom' ? p.gpu.text : p.gpu.value;

  let kernelVersion = '';
  if (visible && p.kernel && !p.kernel.hidden) kernelVersion = p.kernel.text || '';

  return { cpu_name: cpuName, arch, virtualization, gpu_name: gpuName, kernel_version: kernelVersion };
}

// 候选清单：服务端单一事实源（D4），前端下拉经 API 取，不前后端各存一份。
function options() {
  return {
    cpu_vendors: CPU_VENDORS.slice(),
    cpu_tags_by_vendor: Object.fromEntries(
      Object.entries(CPU_TAGS_BY_VENDOR).map(([k, v]) => [k, v.slice()])
    ),
    archs: ARCHS.slice(),
    virtualizations: VIRTUALIZATIONS.slice(),
    gpu_types: GPU_TYPES.slice(),
    max_text_length: MAX_TEXT
  };
}

module.exports = {
  CPU_VENDORS,
  CPU_TAGS_BY_VENDOR,
  ARCHS,
  VIRTUALIZATIONS,
  GPU_TYPES,
  MAX_TEXT,
  MAX_JSON,
  normalizeProfile,
  parseProfile,
  composeCpuName,
  deriveArch,
  publicFields,
  options
};
