// adminApi 契约测试（表驱动）：逐个方法断言「URL + HTTP 方法」。
//
// 为什么值得写满全部方法：
//   1. adminApi 是纯封装层，一条 `api.get(路径)` 写错字在类型层面看不出来，
//      只能靠断言 fetch 入参发现（历史上就有路径漂移导致 404 的先例）；
//   2. vitest 覆盖率门禁含 functions ≥35%，而 adminApi 有 ~60 个箭头函数，
//      只测少数方法会把全局函数覆盖率拖到门禁以下。
// 只断言 URL/Method/Body 形状，不关心返回体（那是各视图与后端契约的事）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { adminApi } from './adminApi';

interface Captured {
  url: string;
  method: string;
  body: string | undefined;
}

const realFetch = global.fetch;

function mockFetch(): Captured[] {
  const captured: Captured[] = [];
  global.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    captured.push({ url, method: init.method || 'GET', body: init.body as string | undefined });
    return {
      ok: true,
      status: 200,
      text: async () => '{}',
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return captured;
}

async function expectCall(
  fn: () => Promise<unknown> | string,
  expected: { url: string; method: string; body?: unknown },
) {
  const captured = mockFetch();
  const result = fn();
  if (typeof result === 'string') {
    expect(result).toBe(expected.url);
    return;
  }
  await result;
  expect(captured).toHaveLength(1);
  expect(captured[0].url).toBe(expected.url);
  expect(captured[0].method).toBe(expected.method);
  if (expected.body !== undefined) {
    expect(JSON.parse(String(captured[0].body))).toEqual(expected.body);
  }
}

describe('adminApi 契约：全部方法 → URL/Method', () => {
  afterEach(() => {
    global.fetch = realFetch;
  });

  // ---- 认证 / 2FA ----
  it('2FA 与登录相关', async () => {
    await expectCall(() => adminApi.status(), { url: '/api/admin/2fa/status', method: 'GET' });
    await expectCall(() => adminApi.twoFAStatus(), { url: '/api/admin/2fa/status', method: 'GET' });
    await expectCall(() => adminApi.login('t', '123456'), {
      url: '/api/login', method: 'POST', body: { token: 't', totp: '123456' },
    });
    await expectCall(() => adminApi.login('t'), { url: '/api/login', method: 'POST', body: { token: 't', totp: undefined } });
    await expectCall(() => adminApi.logout(), { url: '/api/logout', method: 'POST' });
    await expectCall(() => adminApi.setup2FA(), { url: '/api/admin/2fa/setup', method: 'POST', body: {} });
    await expectCall(() => adminApi.enable2FA('123456'), {
      url: '/api/admin/2fa/enable', method: 'POST', body: { code: '123456' },
    });
    await expectCall(() => adminApi.disable2FA('123456'), {
      url: '/api/admin/2fa/disable', method: 'POST', body: { code: '123456' },
    });
  });

  // ---- 初始化 / 受控端 ----
  it('初始化向导与节点 CRUD', async () => {
    await expectCall(() => adminApi.register('st', 'u', 'p'), {
      url: '/api/setup/register', method: 'POST', body: { setup_token: 'st', username: 'u', password: 'p' },
    });
    await expectCall(() => adminApi.generateAgent('n1'), {
      url: '/api/setup/generate', method: 'POST', body: { name: 'n1' },
    });
    await expectCall(() => adminApi.listAgents(), { url: '/api/agents', method: 'GET' });
    await expectCall(() => adminApi.getAgent('agt_1'), { url: '/api/agents/agt_1', method: 'GET' });
    await expectCall(() => adminApi.createAgent({ name: 'n' }), {
      url: '/api/agents', method: 'POST', body: { name: 'n' },
    });
    await expectCall(() => adminApi.updateAgent('agt_1', { note: 'x' }), {
      url: '/api/agents/agt_1', method: 'PUT', body: { note: 'x' },
    });
    await expectCall(() => adminApi.deleteAgent('agt_1'), { url: '/api/agents/agt_1', method: 'DELETE' });
    await expectCall(() => adminApi.resetToken('agt_1'), {
      url: '/api/agents/agt_1/reset-token', method: 'POST', body: {},
    });
    await expectCall(() => adminApi.renewAgent('agt_1'), {
      url: '/api/agents/agt_1/renew', method: 'POST', body: {},
    });
    await expectCall(() => adminApi.getCommands('agt_1'), {
      url: '/api/agents/agt_1/commands', method: 'GET',
    });
    await expectCall(() => adminApi.getCommands('agt_1', '1.1.1.1'), {
      url: '/api/agents/agt_1/commands?probe_targets=1.1.1.1', method: 'GET',
    });
  });

  // ---- V 阶段：受控端版本可判定性 ----
  it('期望版本对照与构建标注', async () => {
    await expectCall(() => adminApi.getAgentVersions(), { url: '/api/admin/agent-versions', method: 'GET' });
    await expectCall(() => adminApi.setExpectedAgentVersion({ version: 'v1.0.9' }), {
      url: '/api/admin/agent-versions/expected', method: 'PUT', body: { version: 'v1.0.9' },
    });
    await expectCall(() => adminApi.setExpectedAgentVersion({ version: '', sha: '' }), {
      url: '/api/admin/agent-versions/expected', method: 'PUT', body: { version: '', sha: '' },
    });
    await expectCall(() => adminApi.setAgentBuildTag('agt_1', 'custom'), {
      url: '/api/admin/agents/agt_1/build-tag', method: 'PUT', body: { tag: 'custom' },
    });
  });

  // ---- D 阶段：受控端二进制 artifact + 一键批量分发 ----
  it('自定义二进制 artifact 的上传 / 列表 / 删除', async () => {
    await expectCall(() => adminApi.listAgentArtifacts(), { url: '/api/admin/agent-artifacts', method: 'GET' });
    await expectCall(() => adminApi.deleteAgentArtifact('art_abc'), {
      url: '/api/admin/agent-artifacts/art_abc', method: 'DELETE',
    });
  });

  it('生成分发包', async () => {
    await expectCall(() => adminApi.createAgentDistribution({
      agent_ids: ['agt_1'],
      target: { os: 'linux', arch: 'amd64' },
      source: { kind: 'official' },
    }), {
      url: '/api/admin/agent-distribution', method: 'POST',
      body: {
        agent_ids: ['agt_1'],
        target: { os: 'linux', arch: 'amd64' },
        source: { kind: 'official' },
      },
    });
  });

// ---- 告警规则覆盖 ----
  it('告警规则（节点 / 分组）', async () => {
    await expectCall(() => adminApi.listAlertRules(), { url: '/api/admin/alert-rules', method: 'GET' });
    await expectCall(() => adminApi.setAgentAlertRule('agt_1', { cpu_pct: 80 }), {
      url: '/api/admin/alert-rules/agent/agt_1', method: 'PUT', body: { cpu_pct: 80 },
    });
    await expectCall(() => adminApi.resetAgentAlertRule('agt_1'), {
      url: '/api/admin/alert-rules/agent/agt_1', method: 'DELETE',
    });
    await expectCall(() => adminApi.setGroupAlertRule('web', { cpu_pct: 80 }), {
      url: '/api/admin/alert-rules/group/web', method: 'PUT', body: { cpu_pct: 80 },
    });
    // 空分组用 '-' 站位于路径段（空字符串无法作为路径段）
    await expectCall(() => adminApi.setGroupAlertRule('', { cpu_pct: 80 }), {
      url: '/api/admin/alert-rules/group/-', method: 'PUT', body: { cpu_pct: 80 },
    });
    await expectCall(() => adminApi.resetGroupAlertRule(''), {
      url: '/api/admin/alert-rules/group/-', method: 'DELETE',
    });
    await expectCall(() => adminApi.resetGroupAlertRule('web'), {
      url: '/api/admin/alert-rules/group/web', method: 'DELETE',
    });
  });

  // ---- 通知渠道 / 通知组 ----
  it('通知渠道与通知组', async () => {
    await expectCall(() => adminApi.listNotifyChannels(), { url: '/api/admin/notify/channels', method: 'GET' });
    await expectCall(() => adminApi.createNotifyChannel({ type: 'webhook', name: 'w' }), {
      url: '/api/admin/notify/channels', method: 'POST', body: { type: 'webhook', name: 'w' },
    });
    await expectCall(() => adminApi.updateNotifyChannel(1, { enabled: false }), {
      url: '/api/admin/notify/channels/1', method: 'PUT', body: { enabled: false },
    });
    await expectCall(() => adminApi.deleteNotifyChannel(1), { url: '/api/admin/notify/channels/1', method: 'DELETE' });
    await expectCall(() => adminApi.testNotifyChannel(1), {
      url: '/api/admin/notify/channels/1/test', method: 'POST', body: {},
    });
    await expectCall(() => adminApi.listNotifyGroups(), { url: '/api/admin/notify/groups', method: 'GET' });
    await expectCall(() => adminApi.createNotifyGroup({ name: 'g', events: ['*'], channel_ids: [1] }), {
      url: '/api/admin/notify/groups', method: 'POST',
      body: { name: 'g', events: ['*'], channel_ids: [1] },
    });
    await expectCall(() => adminApi.updateNotifyGroup(2, { enabled: false }), {
      url: '/api/admin/notify/groups/2', method: 'PUT', body: { enabled: false },
    });
    await expectCall(() => adminApi.deleteNotifyGroup(2), { url: '/api/admin/notify/groups/2', method: 'DELETE' });
    await expectCall(() => adminApi.listNotifyEvents(), { url: '/api/admin/notify/events', method: 'GET' });
    await expectCall(() => adminApi.listThemes(), { url: '/api/public/themes', method: 'GET' });
  });

  // ---- API Token ----
  it('API Token 管理', async () => {
    await expectCall(() => adminApi.listApiTokens(), { url: '/api/admin/api-tokens', method: 'GET' });
    await expectCall(() => adminApi.createApiToken({ name: 'p', scope: 'readonly', agent_ids: ['agt_1'], expires_in_days: 7 }), {
      url: '/api/admin/api-tokens', method: 'POST',
      body: { name: 'p', scope: 'readonly', agent_ids: ['agt_1'], expires_in_days: 7 },
    });
    await expectCall(() => adminApi.revokeApiToken('tok_1'), { url: '/api/admin/api-tokens/tok_1', method: 'DELETE' });
  });

  // ---- 概览 / 设置 / 备份 / 诊断 ----
  it('概览、设置、备份与诊断', async () => {
    await expectCall(() => adminApi.clientIp(), { url: '/api/client-ip', method: 'GET' });
    await expectCall(() => adminApi.overview(), { url: '/api/overview', method: 'GET' });
    await expectCall(() => adminApi.getSettings(), { url: '/api/settings', method: 'GET' });
    await expectCall(() => adminApi.saveSettings({ site_title: 'x' } as never), {
      url: '/api/settings', method: 'PUT', body: { site_title: 'x' },
    });
    await expectCall(() => adminApi.getBackupStatus(), { url: '/api/admin/backup-status', method: 'GET' });
    await expectCall(() => adminApi.listBackups(), { url: '/api/admin/backups', method: 'GET' });
    await expectCall(() => adminApi.deleteBackup('a.db'), { url: '/api/admin/backups/a.db', method: 'DELETE' });
    await expectCall(() => adminApi.requestRestore('a.db'), {
      url: '/api/admin/backups/a.db/restore', method: 'POST', body: {},
    });
    // 下载走同源 GET，直接拼 URL 交给 <a download>，不经过 fetch
    await expectCall(() => adminApi.backupDownloadUrl('a b.db'), {
      url: '/api/admin/backups/a%20b.db/download', method: '',
    });
    await expectCall(() => adminApi.testAlert(), { url: '/api/test-alert', method: 'POST', body: {} });
    await expectCall(() => adminApi.billingOverview(), { url: '/api/billing', method: 'GET' });
  });

  // ---- AI ----
  it('AI 相关端点', async () => {
    await expectCall(() => adminApi.aiConfig(), { url: '/api/ai/config', method: 'GET' });
    await expectCall(() => adminApi.saveAiConfig({ enabled: true }), {
      url: '/api/ai/config', method: 'PUT', body: { config: { enabled: true } },
    });
    await expectCall(() => adminApi.aiStatus(), { url: '/api/ai/status', method: 'GET' });
    await expectCall(() => adminApi.runAi(), { url: '/api/ai/run', method: 'POST', body: {} });
    await expectCall(() => adminApi.runAi({ force: true }), { url: '/api/ai/run?force=1', method: 'POST', body: {} });
    await expectCall(() => adminApi.aiReports(), { url: '/api/ai/reports?limit=20&offset=0', method: 'GET' });
    await expectCall(() => adminApi.aiReport(5), { url: '/api/ai/reports/5', method: 'GET' });
    await expectCall(() => adminApi.aiUsage(), { url: '/api/ai/usage?days=7', method: 'GET' });
    await expectCall(() => adminApi.aiAnalyzeNode('agt_1'), {
      url: '/api/ai/analyze-node/agt_1?hours=24', method: 'POST', body: {},
    });
    await expectCall(() => adminApi.aiNodeReports('agt_1'), {
      url: '/api/ai/node-reports?agent_id=agt_1&limit=10', method: 'GET',
    });
  });

  // ---- 时序 ----
  it('时序与审计', async () => {
    await expectCall(() => adminApi.sparklines(), { url: '/api/agents/sparklines?range=6h', method: 'GET' });
    await expectCall(() => adminApi.sparklines('24h'), { url: '/api/agents/sparklines?range=24h', method: 'GET' });
    await expectCall(() => adminApi.clusterTrend(), { url: '/api/agents/sparklines/overview?range=6h', method: 'GET' });
    await expectCall(() => adminApi.metrics('agt_1'), { url: '/api/agents/agt_1/metrics?range=6h', method: 'GET' });
    await expectCall(() => adminApi.metrics('agt_1', '7d'), { url: '/api/agents/agt_1/metrics?range=7d', method: 'GET' });
    await expectCall(() => adminApi.auditLogs(), { url: '/api/admin/audit-logs?limit=100&offset=0', method: 'GET' });
    await expectCall(() => adminApi.auditLogs(50, 100), { url: '/api/admin/audit-logs?limit=50&offset=100', method: 'GET' });
  });

  // ---- 编码规则：路径参数一律 encodeURIComponent ----
  it('节点 id / 备份名中的特殊字符被编码', async () => {
    await expectCall(() => adminApi.getAgent('a/b'), { url: '/api/agents/a%2Fb', method: 'GET' });
    await expectCall(() => adminApi.deleteBackup('a b'), { url: '/api/admin/backups/a%20b', method: 'DELETE' });
    await expectCall(() => adminApi.revokeApiToken('tok_a/b'), { url: '/api/admin/api-tokens/tok_a%2Fb', method: 'DELETE' });
  });
});
