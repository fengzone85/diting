'use strict';
// ============================================================
// 路由快照：拆分 api.js（P2-1）前后，对外暴露的 method + path 集合必须逐条一致。
//
// 只断言数量不够——数量相同但路径写错（例如 /admin/theme/set 变 /theme/set）
// 在类型层面和单元测试里都发现不了，必须是完整集合的 diff。
//
// 支持子 router：拆分后主 api.js 会用 router.use('/admin/theme', themeRoutes) 挂载，
// 递归 walk 时会从 layer.regexp 解析挂载前缀。
// ============================================================
process.env.DB_PATH = `/tmp/diting-routes-snapshot-${process.pid}.db`;

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const api = require('../src/api');

const EXPECTED = [
  'DELETE /admin/agent-artifacts/:id',
  'DELETE /admin/alert-rules/agent/:id',
  'DELETE /admin/alert-rules/group/:grp',
  'DELETE /admin/api-tokens/:id',
  'DELETE /admin/backups/:name',
  'DELETE /admin/notify/channels/:id',
  'DELETE /admin/notify/groups/:id',
  'DELETE /admin/sessions/:id',
  'DELETE /admin/theme/market/sources/:id',
  'DELETE /agents/:id',
  'GET /admin/2fa/status',
  'GET /admin/agent-artifacts',
  'GET /admin/agent-distribution/:pkg_id/download',
  'GET /admin/agent-versions',
  'GET /admin/alert-rules',
  'GET /admin/api-tokens',
  'GET /admin/audit-logs',
  'GET /admin/backup-status',
  'GET /admin/backups',
  'GET /admin/backups/:name/download',
  'GET /admin/capacity',
  'GET /admin/notify/channels',
  'GET /admin/notify/events',
  'GET /admin/notify/groups',
  'GET /admin/notify/migration-status',
  'GET /admin/restore-audit',
  'GET /admin/sessions',
  'GET /admin/theme/backups',
  'GET /admin/theme/config',
  'GET /admin/theme/list',
  'GET /admin/theme/market/catalog',
  'GET /admin/theme/market/sources',
  'GET /agents',
  'GET /agents/:id',
  'GET /agents/:id/commands',
  'GET /agents/:id/metrics',
  'GET /agents/:id/online-history',
  'GET /agents/deleted',
  'GET /agents/sparklines',
  'GET /agents/sparklines/overview',
  'GET /ai/config',
  'GET /ai/node-reports',
  'GET /ai/reports',
  'GET /ai/reports/:id',
  'GET /ai/status',
  'GET /ai/usage',
  'GET /billing',
  'GET /client-ip',
  'GET /overview',
  'GET /public/agents',
  'GET /public/agents/:id/online-history',
  'GET /public/agents/:id/probes',
  'GET /public/agents/sparklines',
  'GET /public/meta',
  'GET /public/overview',
  'GET /public/themes',
  'GET /public/visitor',
  'GET /settings',
  'GET /setup-token',
  'GET /setup/status',
  'PATCH /agents/:id/traffic',
  'POST /admin/2fa/disable',
  'POST /admin/2fa/enable',
  'POST /admin/2fa/setup',
  'POST /admin/agent-artifacts',
  'POST /admin/agent-distribution',
  'POST /admin/api-tokens',
  'POST /admin/backups',
  'POST /admin/backups/:name/restore',
  'POST /admin/backups/upload',
  'POST /admin/capacity/cleanup',
  'POST /admin/notify/channels',
  'POST /admin/notify/channels/:id/test',
  'POST /admin/notify/groups',
  'POST /admin/sessions/revoke-all',
  'POST /admin/theme/config',
  'POST /admin/theme/delete',
  'POST /admin/theme/import',
  'POST /admin/theme/market/install',
  'POST /admin/theme/market/sources',
  'POST /admin/theme/rollback',
  'POST /admin/theme/set',
  'POST /admin/theme/update',
  'POST /agents',
  'POST /agents/:id/approve',
  'POST /agents/:id/renew',
  'POST /agents/:id/reset-token',
  'POST /agents/:id/restore',
  'POST /ai/analyze-node/:id',
  'POST /ai/run',
  'POST /login',
  'POST /logout',
  'POST /public/order',
  'POST /report',
  'POST /setup-token',
  'POST /setup/generate',
  'POST /setup/register',
  'POST /test-alert',
  'PUT /admin/agent-versions/expected',
  'PUT /admin/agents/:id/build-tag',
  'PUT /admin/alert-rules/agent/:id',
  'PUT /admin/alert-rules/group/:grp',
  'PUT /admin/dashboard/layout',
  'PUT /admin/notify/channels/:id',
  'PUT /admin/notify/groups/:id',
  'PUT /admin/theme/market/sources/:id',
  'PUT /agents/:id',
  'PUT /ai/config',
  'PUT /settings',
];

// 从 Express 挂载层的 regexp 解析前缀：/^\/admin\/theme\/?(?=\/|$)/i
function mountPath(layer) {
  const src = (layer.regexp && layer.regexp.source) || '';
  const m = src.match(/^\^\\\/(.+?)\\\/\?\(\?=/);
  if (!m) return '';
  return '/' + m[1].replace(/\\\//g, '/');
}

function walk(stack, prefix = '') {
  const out = [];
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      for (const m of methods) out.push(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      out.push(...walk(layer.handle.stack, prefix + mountPath(layer)));
    }
  }
  return out;
}

test('路由快照：拆分前后 method + path 集合逐条一致', () => {
  const actual = walk(api.stack).sort();
  assert.strictEqual(actual.length, EXPECTED.length, `路由数量变化：${actual.length} vs ${EXPECTED.length}`);
  assert.deepStrictEqual(actual, EXPECTED);
});

test('路由快照：admin 路由 61 条、无前缀路由 9 条', () => {
  const all = walk(api.stack);
  assert.strictEqual(all.filter((r) => r.includes(' /admin/')).length, 61);
  const noPrefix = all.filter((r) => {
    const p = r.split(' ')[1];
    return p === '/report' || p === '/overview' || p === '/billing' || p === '/client-ip'
      || p === '/settings' || p === '/test-alert' || p === '/login' || p === '/logout';
  });
  assert.strictEqual(noPrefix.length, 9, `无前缀路由应为 9 条，实际 ${noPrefix.length}`);
});

test('清理临时库', () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* 忽略 */ }
  }
});
