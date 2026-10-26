'use strict';
// ============================================================
// 探测目标命令生成：换行归一化 + 写回格式约束
//
// 背景（2026-10-26 真机定位到根因）：
//   wxwin-go 的 `run_scheduled.bat` 里 `set PROBE_TARGETS=…` 一直**没生效**，
//   受控端始终上报内置默认目标（CM/CT/CU/GG）。
//   根因不是编码，而是**换行符**：
//     · 该 bat 495 字节里 CRLF 9 个、LF-only 1 个，那个孤立 LF 正好在
//       `set MONTH_ROTATE=1` 与 `set PROBE_TARGETS=…` 之间；
//     · cmd 只把 CRLF 当行分隔 ⇒ 两行被并成一条命令 ⇒ PROBE_TARGETS 成了
//       MONTH_ROTATE 的值的一部分，从未被设置。
//   而那个 LF 来自服务端「修改探测目标」命令：值里带换行 → `Set-Content` 写出。
//   同时 `Set-Content` 在 PS 5.1 默认 ANSI，会把既有 UTF-8 中文二次编码（双编码）。
//
// 本测试守住三条约束：
//   1. 入参里的换行必须归一化成逗号（多行 = 一行一个目标，等价于逗号分隔）；
//   2. 生成的命令里不得出现裸换行（否则写进 bat 就是那个致命 LF）；
//   3. Windows 命令必须显式用 CRLF + UTF-8(no BOM) + 按 UTF-8 读回。
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');

const api = require('../src/api');

const PT_MULTILINE = '移动:211.136.192.6\n电信:101.226.4.6\r\n联通:202.106.0.20\n公共:8.8.8.8';

test('buildModifyCommands：多行入参归一化为逗号分隔，且不含换行', () => {
  const r = api.buildModifyCommands('https://h', 'agt_x', PT_MULTILINE);
  assert.strictEqual(r.probe_targets, '移动:211.136.192.6,电信:101.226.4.6,联通:202.106.0.20,公共:8.8.8.8');
  assert.ok(!/[\r\n]/.test(r.probe_targets), '归一化结果不得含换行');
});

test('buildModifyCommands：连续逗号与首尾逗号被规整', () => {
  assert.strictEqual(api.buildModifyCommands('https://h', 'agt_x', ',,A:1.1.1.1,,B:2.2.2.2,,').probe_targets, 'A:1.1.1.1,B:2.2.2.2');
  assert.strictEqual(api.buildModifyCommands('https://h', 'agt_x', '').probe_targets, '');
  assert.strictEqual(api.buildModifyCommands('https://h', 'agt_x', '\n\n').probe_targets, '');
});

test('buildModifyCommands：两条命令里都不出现裸换行（防把 LF 写进 bat / drop-in）', () => {
  const r = api.buildModifyCommands('https://h', 'agt_x', PT_MULTILINE);
  // linux：写 systemd drop-in，值里带换行会破坏 unit 文件
  assert.ok(!r.linux_cmd.includes('\n移动'), 'linux 命令不得把换行注入到 Environment= 里');
  // windows：PowerShell 源码里除自身行分隔外，不得含裸 LF
  const winBody = r.windows_cmd.replace(/\r\n/g, '\n');
  const lines = winBody.split('\n');
  assert.ok(lines.length > 3, 'windows 命令应是多行 PowerShell 脚本');
  for (const l of lines) {
    assert.ok(!l.includes('\r'), `windows 命令某行含裸 CR：${JSON.stringify(l.slice(0, 40))}`);
  }
});

test('buildModifyCommands：Windows 写回必须显式 CRLF + UTF-8 + 按 UTF-8 读', () => {
  const r = api.buildModifyCommands('https://h', 'agt_x', 'A:1.1.1.1');
  assert.ok(/\[char\]13/.test(r.windows_cmd), '应显式构造 CRLF（[char]13）');
  assert.ok(/WriteAllText/.test(r.windows_cmd), '应用 WriteAllText 写入（Set-Content 编码/换行不可控）');
  assert.ok(/UTF8Encoding\(\$false\)/.test(r.windows_cmd), '应写 UTF-8 no BOM（避免中文双编码）');
  assert.ok(/-Encoding UTF8/.test(r.windows_cmd), '应按 UTF-8 读回（避免读出乱码再写回）');
  assert.ok(!/Set-Content/.test(r.windows_cmd), '不得再用 Set-Content（PS 5.1 默认 ANSI）');
});

test('buildInstallCommands：安装命令里的探测目标同样不含换行', () => {
  const r = api.buildInstallCommands('https://h', 'agt_x', 'tok', 20, PT_MULTILINE, 1);
  assert.ok(!/[\r\n]/.test(r.probe_targets), '归一化后的 probe_targets 不得含换行');
  assert.ok(r.native_cmd.includes('移动:211.136.192.6,电信:101.226.4.6'), '安装命令应以逗号分隔');
  assert.ok(/--probe-targets|PROBE_TARGETS|ProbeTargets/.test(r.native_cmd + r.docker_cmd + r.windows_cmd));
});
