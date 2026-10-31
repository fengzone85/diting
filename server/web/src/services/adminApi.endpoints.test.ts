// adminApi 端点契约表：路径 / HTTP 方法 / 请求体形状一旦改动，前端与后端就会悄悄错位，
// 这类错误在类型层面看不出来，只能靠断言 fetch 入参锁住。
// 与 adminApi.test.ts（API Token 重点用例）互补：本文件用表驱动覆盖其余端点。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { adminApi } from './adminApi';

interface Captured {
  url: string;
  init: RequestInit;
}

function mockFetch(body: unknown = {}, status = 200) {
  const captured: Captured[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    captured.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  }));
  return captured;
}

type Case = {
  name: string;
  run: () => Promise<unknown>;
  method: string;
  url: string;
  body?: unknown;
};

const cases: Case[] = [
  // ---- auth / 2fa / setup ----
  { name: 'status', run: () => adminApi.status(), method: 'GET', url: '/api/admin/2fa/status' },
  { name: 'twoFAStatus', run: () => adminApi.twoFAStatus(), method: 'GET', url: '/api/admin/2fa/status' },
  { name: 'login 无 totp', run: () => adminApi.login('tok'), method: 'POST', url: '/api/login', body: { token: 'tok' } },
  { name: 'login 带 totp', run: () => adminApi.login('tok', '123456'), method: 'POST', url: '/api/login', body: { token: 'tok', totp: '123456' } },
  { name: 'logout', run: () => adminApi.logout(), method: 'POST', url: '/api/logout' },
  { name: 'setup2FA', run: () => adminApi.setup2FA(), method: 'POST', url: '/api/admin/2fa/setup', body: {} },
  { name: 'enable2FA', run: () => adminApi.enable2FA('123456'), method: 'POST', url: '/api/admin/2fa/enable', body: { code: '123456' } },
  { name: 'disable2FA', run: () => adminApi.disable2FA('123456'), method: 'POST', url: '/api/admin/2fa/disable', body: { code: '123456' } },
  { name: 'register', run: () => adminApi.register('st', 'admin', 'pw'), method: 'POST', url: '/api/setup/register', body: { setup_token: 'st', username: 'admin', password: 'pw' } },
  { name: 'generateAgent', run: () => adminApi.generateAgent('n1'), method: 'POST', url: '/api/setup/generate', body: { name: 'n1' } },
  { name: 'setupTokenStatus', run: () => adminApi.setupTokenStatus(), method: 'GET', url: '/api/admin/setup-token' },
  { name: 'setupTokenRotate generate', run: () => adminApi.setupTokenRotate('generate'), method: 'POST', url: '/api/admin/setup-token', body: { action: 'generate' } },
  { name: 'setupTokenRotate set', run: () => adminApi.setupTokenRotate('set', 'abc'), method: 'POST', url: '/api/admin/setup-token', body: { action: 'set', token: 'abc' } },
  { name: 'setupTokenRotate clear', run: () => adminApi.setupTokenRotate('clear'), method: 'POST', url: '/api/admin/setup-token', body: { action: 'clear' } },

  // ---- agents ----
  { name: 'listAgents', run: () => adminApi.listAgents(), method: 'GET', url: '/api/agents' },
  { name: 'getAgent 编码 id', run: () => adminApi.getAgent('a/b'), method: 'GET', url: '/api/agents/a%2Fb' },
  { name: 'createAgent', run: () => adminApi.createAgent({ name: 'n' }), method: 'POST', url: '/api/agents', body: { name: 'n' } },
  { name: 'updateAgent', run: () => adminApi.updateAgent('a/b', { name: 'n' }), method: 'PUT', url: '/api/agents/a%2Fb', body: { name: 'n' } },
  { name: 'deleteAgent', run: () => adminApi.deleteAgent('a/b'), method: 'DELETE', url: '/api/agents/a%2Fb' },
  { name: 'listDeletedAgents', run: () => adminApi.listDeletedAgents(), method: 'GET', url: '/api/agents/deleted' },
  { name: 'restoreAgent', run: () => adminApi.restoreAgent('a'), method: 'POST', url: '/api/agents/a/restore', body: {} },
  { name: 'resetToken', run: () => adminApi.resetToken('a'), method: 'POST', url: '/api/agents/a/reset-token', body: {} },
  { name: 'renewAgent', run: () => adminApi.renewAgent('a'), method: 'POST', url: '/api/agents/a/renew', body: {} },
  { name: 'getCommands 无 probeTargets', run: () => adminApi.getCommands('a'), method: 'GET', url: '/api/agents/a/commands' },
  { name: 'getCommands 带 probeTargets', run: () => adminApi.getCommands('a', 'x y'), method: 'GET', url: '/api/agents/a/commands?probe_targets=x%20y' },
  { name: 'getAgentVersions', run: () => adminApi.getAgentVersions(), method: 'GET', url: '/api/admin/agent-versions' },
  { name: 'setExpectedAgentVersion', run: () => adminApi.setExpectedAgentVersion({ version: '1.1.5' }), method: 'PUT', url: '/api/admin/agent-versions/expected', body: { version: '1.1.5' } },
  { name: 'setAgentBuildTag', run: () => adminApi.setAgentBuildTag('a/b', 'v1'), method: 'PUT', url: '/api/admin/agents/a%2Fb/build-tag', body: { tag: 'v1' } },
  { name: 'listAgentArtifacts', run: () => adminApi.listAgentArtifacts(), method: 'GET', url: '/api/admin/agent-artifacts' },
  { name: 'deleteAgentArtifact', run: () => adminApi.deleteAgentArtifact('a/b'), method: 'DELETE', url: '/api/admin/agent-artifacts/a%2Fb' },
  {
    name: 'createAgentDistribution',
    run: () => adminApi.createAgentDistribution({
      agent_ids: ['a'], target: { os: 'linux', arch: 'amd64' }, source: { kind: 'release' },
    }),
    method: 'POST',
    url: '/api/admin/agent-distribution',
    body: { agent_ids: ['a'], target: { os: 'linux', arch: 'amd64' }, source: { kind: 'release' } },
  },

  // ---- alert rules ----
  { name: 'listAlertRules', run: () => adminApi.listAlertRules(), method: 'GET', url: '/api/admin/alert-rules' },
  { name: 'setAgentAlertRule', run: () => adminApi.setAgentAlertRule('a/b', { cpu: 90 }), method: 'PUT', url: '/api/admin/alert-rules/agent/a%2Fb', body: { cpu: 90 } },
  { name: 'resetAgentAlertRule', run: () => adminApi.resetAgentAlertRule('a'), method: 'DELETE', url: '/api/admin/alert-rules/agent/a' },
  { name: 'setGroupAlertRule 未分组 → -', run: () => adminApi.setGroupAlertRule('', { cpu: 90 }), method: 'PUT', url: '/api/admin/alert-rules/group/-', body: { cpu: 90 } },
  { name: 'setGroupAlertRule 分组名编码', run: () => adminApi.setGroupAlertRule('g 1', { cpu: 90 }), method: 'PUT', url: '/api/admin/alert-rules/group/g%201', body: { cpu: 90 } },
  { name: 'resetGroupAlertRule 未分组 → -', run: () => adminApi.resetGroupAlertRule(''), method: 'DELETE', url: '/api/admin/alert-rules/group/-' },
  { name: 'resetGroupAlertRule 普通分组', run: () => adminApi.resetGroupAlertRule('g'), method: 'DELETE', url: '/api/admin/alert-rules/group/g' },

  // ---- notify ----
  { name: 'listNotifyChannels', run: () => adminApi.listNotifyChannels(), method: 'GET', url: '/api/admin/notify/channels' },
  { name: 'createNotifyChannel', run: () => adminApi.createNotifyChannel({ type: 'webhook', name: 'n' }), method: 'POST', url: '/api/admin/notify/channels', body: { type: 'webhook', name: 'n' } },
  { name: 'updateNotifyChannel', run: () => adminApi.updateNotifyChannel(1, { enabled: true }), method: 'PUT', url: '/api/admin/notify/channels/1', body: { enabled: true } },
  { name: 'deleteNotifyChannel', run: () => adminApi.deleteNotifyChannel(2), method: 'DELETE', url: '/api/admin/notify/channels/2' },
  { name: 'testNotifyChannel', run: () => adminApi.testNotifyChannel(3), method: 'POST', url: '/api/admin/notify/channels/3/test', body: {} },
  { name: 'listNotifyGroups', run: () => adminApi.listNotifyGroups(), method: 'GET', url: '/api/admin/notify/groups' },
  { name: 'createNotifyGroup', run: () => adminApi.createNotifyGroup({ name: 'g', events: ['down'], channel_ids: [1] }), method: 'POST', url: '/api/admin/notify/groups', body: { name: 'g', events: ['down'], channel_ids: [1] } },
  { name: 'updateNotifyGroup', run: () => adminApi.updateNotifyGroup(4, { name: 'g2' }), method: 'PUT', url: '/api/admin/notify/groups/4', body: { name: 'g2' } },
  { name: 'deleteNotifyGroup', run: () => adminApi.deleteNotifyGroup(5), method: 'DELETE', url: '/api/admin/notify/groups/5' },
  { name: 'listNotifyEvents', run: () => adminApi.listNotifyEvents(), method: 'GET', url: '/api/admin/notify/events' },
  { name: 'notifyMigrationStatus', run: () => adminApi.notifyMigrationStatus(), method: 'GET', url: '/api/admin/notify/migration-status' },
  { name: 'listThemes', run: () => adminApi.listThemes(), method: 'GET', url: '/api/public/themes' },

  // ---- theme market ----
  { name: 'listInstalledThemes', run: () => adminApi.listInstalledThemes(), method: 'GET', url: '/api/admin/theme/list' },
  { name: 'listThemeSources', run: () => adminApi.listThemeSources(), method: 'GET', url: '/api/admin/theme/market/sources' },
  { name: 'createThemeSource', run: () => adminApi.createThemeSource({ name: 'n', url: 'u' }), method: 'POST', url: '/api/admin/theme/market/sources', body: { name: 'n', url: 'u' } },
  { name: 'updateThemeSource', run: () => adminApi.updateThemeSource('id/x', { name: 'n' }), method: 'PUT', url: '/api/admin/theme/market/sources/id%2Fx', body: { name: 'n' } },
  { name: 'deleteThemeSource', run: () => adminApi.deleteThemeSource('id'), method: 'DELETE', url: '/api/admin/theme/market/sources/id' },
  { name: 'themeCatalog 默认不刷新', run: () => adminApi.themeCatalog(), method: 'GET', url: '/api/admin/theme/market/catalog' },
  { name: 'themeCatalog refresh', run: () => adminApi.themeCatalog(true), method: 'GET', url: '/api/admin/theme/market/catalog?refresh=true' },
  { name: 'installTheme', run: () => adminApi.installTheme('s', 'short'), method: 'POST', url: '/api/admin/theme/market/install', body: { source_id: 's', short: 'short' } },
  { name: 'importTheme 预览', run: () => adminApi.importTheme('http://x/a.zip', true), method: 'POST', url: '/api/admin/theme/import?preview=true', body: { url: 'http://x/a.zip' } },
  { name: 'importTheme 默认不预览', run: () => adminApi.importTheme('http://x/a.zip'), method: 'POST', url: '/api/admin/theme/import', body: { url: 'http://x/a.zip' } },
  { name: 'updateTheme 仅 short', run: () => adminApi.updateTheme('s'), method: 'POST', url: '/api/admin/theme/update', body: { short: 's' } },
  { name: 'updateTheme 带 git 仓库', run: () => adminApi.updateTheme('s', { git_owner: 'o', git_repo: 'r' }), method: 'POST', url: '/api/admin/theme/update', body: { short: 's', git_owner: 'o', git_repo: 'r' } },
  { name: 'rollbackTheme', run: () => adminApi.rollbackTheme('s', 'b'), method: 'POST', url: '/api/admin/theme/rollback', body: { short: 's', backup: 'b' } },
  { name: 'listThemeBackups', run: () => adminApi.listThemeBackups('s 1'), method: 'GET', url: '/api/admin/theme/backups?short=s%201' },
  { name: 'setTheme', run: () => adminApi.setTheme('default'), method: 'POST', url: '/api/admin/theme/set', body: { theme: 'default' } },
  { name: 'deleteTheme', run: () => adminApi.deleteTheme('s'), method: 'POST', url: '/api/admin/theme/delete', body: { short: 's' } },
  { name: 'getThemeConfig', run: () => adminApi.getThemeConfig('t 1'), method: 'GET', url: '/api/admin/theme/config?theme=t%201' },
  { name: 'saveThemeConfig', run: () => adminApi.saveThemeConfig('t', { a: 1 }), method: 'POST', url: '/api/admin/theme/config?theme=t', body: { a: 1 } },

  // ---- api tokens / sessions ----
  { name: 'listApiTokens', run: () => adminApi.listApiTokens(), method: 'GET', url: '/api/admin/api-tokens' },
  { name: 'revokeApiToken', run: () => adminApi.revokeApiToken('t/x'), method: 'DELETE', url: '/api/admin/api-tokens/t%2Fx' },
  { name: 'listSessions', run: () => adminApi.listSessions(), method: 'GET', url: '/api/admin/sessions' },
  { name: 'revokeSession', run: () => adminApi.revokeSession('s/x'), method: 'DELETE', url: '/api/admin/sessions/s%2Fx' },
  { name: 'revokeAllSessions 默认保留当前', run: () => adminApi.revokeAllSessions(), method: 'POST', url: '/api/admin/sessions/revoke-all', body: { keep_current: true } },
  { name: 'revokeAllSessions 全部吊销', run: () => adminApi.revokeAllSessions(false), method: 'POST', url: '/api/admin/sessions/revoke-all', body: { keep_current: false } },

  // ---- settings / backups / capacity ----
  { name: 'clientIp', run: () => adminApi.clientIp(), method: 'GET', url: '/api/client-ip' },
  { name: 'overview', run: () => adminApi.overview(), method: 'GET', url: '/api/overview' },
  { name: 'getSettings', run: () => adminApi.getSettings(), method: 'GET', url: '/api/settings' },
  { name: 'saveSettings', run: () => adminApi.saveSettings({} as never), method: 'PUT', url: '/api/settings', body: {} },
  { name: 'saveDashboardLayout', run: () => adminApi.saveDashboardLayout([]), method: 'PUT', url: '/api/admin/dashboard/layout', body: { layout: [] } },
  { name: 'getBackupStatus', run: () => adminApi.getBackupStatus(), method: 'GET', url: '/api/admin/backup-status' },
  { name: 'getCapacity', run: () => adminApi.getCapacity(), method: 'GET', url: '/api/admin/capacity' },
  { name: 'cleanupCapacity', run: () => adminApi.cleanupCapacity(), method: 'POST', url: '/api/admin/capacity/cleanup' },
  { name: 'getRestoreAudit', run: () => adminApi.getRestoreAudit(), method: 'GET', url: '/api/admin/restore-audit' },
  { name: 'createBackup', run: () => adminApi.createBackup(), method: 'POST', url: '/api/admin/backups' },
  { name: 'listBackups', run: () => adminApi.listBackups(), method: 'GET', url: '/api/admin/backups' },
  { name: 'deleteBackup', run: () => adminApi.deleteBackup('n/x'), method: 'DELETE', url: '/api/admin/backups/n%2Fx' },
  { name: 'requestRestore', run: () => adminApi.requestRestore('n x'), method: 'POST', url: '/api/admin/backups/n%20x/restore', body: {} },
  { name: 'testAlert', run: () => adminApi.testAlert(), method: 'POST', url: '/api/test-alert', body: {} },
  { name: 'billingOverview', run: () => adminApi.billingOverview(), method: 'GET', url: '/api/billing' },

  // ---- AI ----
  { name: 'aiConfig', run: () => adminApi.aiConfig(), method: 'GET', url: '/api/ai/config' },
  { name: 'saveAiConfig', run: () => adminApi.saveAiConfig({ enabled: true }), method: 'PUT', url: '/api/ai/config', body: { config: { enabled: true } } },
  { name: 'aiStatus', run: () => adminApi.aiStatus(), method: 'GET', url: '/api/ai/status' },
  { name: 'runAi 默认', run: () => adminApi.runAi(), method: 'POST', url: '/api/ai/run', body: {} },
  { name: 'runAi force', run: () => adminApi.runAi({ force: true }), method: 'POST', url: '/api/ai/run?force=1', body: {} },
  { name: 'aiReports 默认分页', run: () => adminApi.aiReports(), method: 'GET', url: '/api/ai/reports?limit=20&offset=0' },
  { name: 'aiReports 显式分页', run: () => adminApi.aiReports(5, 10), method: 'GET', url: '/api/ai/reports?limit=5&offset=10' },
  { name: 'aiReport', run: () => adminApi.aiReport(7), method: 'GET', url: '/api/ai/reports/7' },
  { name: 'aiUsage 默认', run: () => adminApi.aiUsage(), method: 'GET', url: '/api/ai/usage?days=7' },
  { name: 'aiUsage 显式天数', run: () => adminApi.aiUsage(30), method: 'GET', url: '/api/ai/usage?days=30' },
  { name: 'aiAnalyzeNode 默认窗口', run: () => adminApi.aiAnalyzeNode('a/b'), method: 'POST', url: '/api/ai/analyze-node/a%2Fb?hours=24', body: {} },
  { name: 'aiAnalyzeNode 7 天窗口', run: () => adminApi.aiAnalyzeNode('a', 168), method: 'POST', url: '/api/ai/analyze-node/a?hours=168', body: {} },
  { name: 'aiNodeReports', run: () => adminApi.aiNodeReports('a b'), method: 'GET', url: '/api/ai/node-reports?agent_id=a%20b&limit=10' },

  // ---- metrics ----
  { name: 'sparklines 默认 6h', run: () => adminApi.sparklines(), method: 'GET', url: '/api/agents/sparklines?range=6h' },
  { name: 'sparklines 7d', run: () => adminApi.sparklines('7d'), method: 'GET', url: '/api/agents/sparklines?range=7d' },
  { name: 'clusterTrend', run: () => adminApi.clusterTrend('24h'), method: 'GET', url: '/api/agents/sparklines/overview?range=24h' },
  { name: 'metrics', run: () => adminApi.metrics('a/b', '1h'), method: 'GET', url: '/api/agents/a%2Fb/metrics?range=1h' },
  { name: 'auditLogs 默认', run: () => adminApi.auditLogs(), method: 'GET', url: '/api/admin/audit-logs?limit=100&offset=0' },
  { name: 'auditLogs 显式分页', run: () => adminApi.auditLogs(5, 10), method: 'GET', url: '/api/admin/audit-logs?limit=5&offset=10' },
];

describe('adminApi 端点契约', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(cases)('$name', async (c) => {
    const captured = mockFetch({});
    await c.run();
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(c.url);
    expect(captured[0].init.method).toBe(c.method);
    if (c.body !== undefined) {
      expect(JSON.parse(String(captured[0].init.body))).toEqual(c.body);
    }
  });

  it('backupDownloadUrl 是纯函数，不走 fetch 且对文件名编码', () => {
    const captured = mockFetch({});
    expect(adminApi.backupDownloadUrl('n x.db')).toBe('/api/admin/backups/n%20x.db/download');
    expect(captured).toHaveLength(0);
  });
});
