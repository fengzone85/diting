// ============================================================
// S2/F5 端到端回归：后台「API Token」页（真实浏览器）
//
// 覆盖：登录 → 签发（名称/权限/节点/有效期）→ 明文一次性展示 → 复制 →
//       作用域生效（全局面 403 forbidden_scope / 越权节点 403 forbidden_node /
//       白名单内可写）→ 吊销后立即 401。
//
// 为什么不在 `npm test` 里跑：需要 Chromium 与一个真实运行中的服务端，
// 也不能进本项目依赖（CI 的 `npm install` 会把浏览器拖进流水线）。
//
// 使用：
//   1) 在仓库外装 Playwright（不污染项目依赖）：
//        mkdir -p ~/diting-e2e && cd ~/diting-e2e
//        npm i playwright && npx playwright install chromium
//   2) 运行：
//        E2E_BASE_URL=https://192.168.0.6 \
//        E2E_PLAYWRIGHT_DIR=~/diting-e2e \
//        npm run e2e:tokens
//      凭据默认读 server/.env 的 ADMIN_TOKEN，也可用 E2E_ADMIN_TOKEN 覆盖。
//   3) 可选 E2E_DB_PATH：给出后测试结束会删除临时 Token 行；
//      不给则只吊销（列表里会留下一条「已吊销」记录，无安全风险）。
//
// 退出码：0 通过 / 1 断言失败 / 2 环境缺失。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..', '..');

const BASE = (process.env.E2E_BASE_URL || 'https://127.0.0.1').replace(/\/+$/, '');
const TOKEN_NAME = 'e2e-' + Date.now().toString(36);

const log = (...a) => console.log('[e2e]', ...a);
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };

function readEnvFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trim().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  } catch { return {}; }
}

const envFile = readEnvFile(path.join(SERVER_DIR, '.env'));
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN || envFile.ADMIN_TOKEN || '';
const DB_PATH = process.env.E2E_DB_PATH || '';

async function loadPlaywright() {
  const dir = process.env.E2E_PLAYWRIGHT_DIR;
  try {
    if (dir) {
      const requireFromDir = createRequire(pathToFileURL(path.join(dir, 'noop.js')));
      return requireFromDir('playwright');
    }
    return await import('playwright');
  } catch (e) {
    console.error([
      '[e2e] 找不到 playwright。请在仓库外安装后重试（不要加进本项目依赖）：',
      '  mkdir -p ~/diting-e2e && cd ~/diting-e2e',
      '  npm i playwright && npx playwright install chromium',
      '  E2E_PLAYWRIGHT_DIR=~/diting-e2e npm run e2e:tokens',
      `  （原始错误：${e.message}）`,
    ].join('\n'));
    process.exit(2);
  }
}

if (!ADMIN_TOKEN) {
  console.error('[e2e] 缺少管理员 Token：设置 E2E_ADMIN_TOKEN，或确保 server/.env 里有 ADMIN_TOKEN。');
  process.exit(2);
}

const { chromium, request: pwRequest } = await loadPlaywright();

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'zh-CN' });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await ctx.newPage();

// 只把真正的 JS 异常当失败：登录前探活请求的 401 会被浏览器记成
// "Failed to load resource"，属预期噪声。
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text());
});
page.on('dialog', (d) => d.accept());

// 独立（无 Cookie）上下文：确保鉴权走 X-API-Token 而不是浏览器 Session。
const anon = await pwRequest.newContext({ ignoreHTTPSErrors: true });

try {
  // ---- 登录 ----
  await page.goto(BASE + '/login');
  await page.fill('input[type=password]', ADMIN_TOKEN);
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin**', { timeout: 20000 });
  log('登录成功');

  // ---- 进入 API Token 页 ----
  await page.goto(BASE + '/admin/api-tokens');
  await page.waitForSelector('input[maxlength="64"]', { timeout: 15000 });
  // 注意：侧边栏也带 .glass，必须用 .glass.p-6 定位内容卡片
  const card = page.locator('.glass.p-6').first();

  await card.locator('input[maxlength="64"]').fill(TOKEN_NAME);
  // 选 admin：只读 Token 的写请求会先被 adminOnly 拦成 "admin required"，
  // 走不到作用域判定，因此验证 forbidden_scope/forbidden_node 必须是 admin+白名单。
  await card.locator('select').selectOption('admin');
  await card.locator('input[type=number]').fill('7');
  const cb = card.locator('input[type=checkbox]').first();
  await cb.check();
  const agentId = (await cb.locator('xpath=ancestor::label//span[contains(@class,"font-mono")]').textContent()).trim();
  assert(/^agt_/.test(agentId), '应能读到所选节点 id，实际=' + agentId);
  log('选择节点:', agentId);

  // ---- 签发 + 一次性明文 ----
  await card.locator('button.bg-sky-500').click();
  await page.waitForSelector('code', { timeout: 15000 });
  const token = (await page.locator('code').first().textContent()).trim();
  assert(/^diting_[0-9a-f]{48}$/.test(token), '明文格式不符');
  log('签发成功');

  // ---- 复制 ----
  await page.locator('xpath=//code/following-sibling::button[1]').click();
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  assert(clip === token, '剪贴板内容与明文不一致');
  log('复制成功');

  // ---- 作用域 ----
  const hdr = { 'X-API-Token': token };
  const listRes = await anon.get(BASE + '/api/agents', { headers: hdr });
  assert(listRes.status() === 200, '/agents 应 200，实际 ' + listRes.status());
  const ids = (await listRes.json()).map((a) => a.id);
  assert(ids.length === 1 && ids[0] === agentId, '列表应只含白名单节点，实际=' + JSON.stringify(ids));
  log('/agents 仅返回白名单节点');

  const ovRes = await anon.get(BASE + '/api/overview', { headers: hdr });
  assert(ovRes.status() === 403 && (await ovRes.json()).error === 'forbidden_scope', '/overview 应 forbidden_scope');

  const setRes = await anon.put(BASE + '/api/settings', { headers: hdr, data: {} });
  assert(setRes.status() === 403 && (await setRes.json()).error === 'forbidden_scope', 'PUT /settings 应 forbidden_scope');

  const createRes = await anon.post(BASE + '/api/agents', { headers: hdr, data: { name: 'x' } });
  assert(createRes.status() === 403 && (await createRes.json()).error === 'forbidden_scope', 'POST /agents 应 forbidden_scope');

  // 审计日志含全部节点 id 与操作轨迹，同样属跨节点信息
  const auditRes = await anon.get(BASE + '/api/admin/audit-logs', { headers: hdr });
  assert(auditRes.status() === 403 && (await auditRes.json()).error === 'forbidden_scope', '/admin/audit-logs 应 forbidden_scope');
  log('全局面拦截 OK');

  // 越权节点（需要库里有第二个节点）
  const adminList = await anon.get(BASE + '/api/agents', {
    headers: { 'X-Admin-Token': ADMIN_TOKEN, 'X-Forwarded-Proto': 'https' },
  });
  const all = await adminList.json();
  const other = Array.isArray(all) ? all.map((a) => a.id).find((id) => id !== agentId) : null;
  if (other) {
    const r = await anon.get(BASE + '/api/agents/' + encodeURIComponent(other), { headers: hdr });
    assert(r.status() === 403 && (await r.json()).error === 'forbidden_node', '越权读应 forbidden_node，实际 ' + r.status());
    const w = await anon.put(BASE + '/api/agents/' + encodeURIComponent(other), { headers: hdr, data: { note: 'x' } });
    assert(w.status() === 403 && (await w.json()).error === 'forbidden_node', '越权写应 forbidden_node，实际 ' + w.status());
    log('单节点越权读/写拦截 OK');
  } else {
    log('库中只有 1 个节点，跳过越权节点用例');
  }

  const ownPut = await anon.put(BASE + '/api/agents/' + encodeURIComponent(agentId), { headers: hdr, data: { note: 'e2e ok' } });
  assert(ownPut.status() === 200, '白名单内节点写应 200，实际 ' + ownPut.status());
  log('白名单内写操作放行 OK');

  // ---- 吊销 ----
  await page.getByRole('button', { name: /吊销|Revoke/ }).first().click();
  await page.waitForTimeout(800);
  const afterRevoke = await anon.get(BASE + '/api/agents', { headers: hdr });
  assert(afterRevoke.status() === 401, '吊销后应 401，实际 ' + afterRevoke.status());
  log('吊销生效 OK');

  assert(pageErrors.length === 0, '页面控制台报错: ' + pageErrors.join(' | '));
  log('页面无 JS 报错');
  console.log('\nE2E PASS');
} catch (e) {
  console.error('\nE2E FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await anon.dispose();
  if (DB_PATH) {
    try {
      const require = createRequire(path.join(SERVER_DIR, 'index.js'));
      const Database = require('better-sqlite3');
      const db = new Database(DB_PATH);
      const n = db.prepare('DELETE FROM api_tokens WHERE name = ?').run(TOKEN_NAME).changes;
      db.close();
      log('已清理临时 Token 行:', n);
    } catch (e) {
      console.warn('[e2e] 清理失败（该行已吊销，无安全风险）:', e.message);
    }
  } else {
    log('未提供 E2E_DB_PATH：保留已吊销的临时 Token 记录（name=' + TOKEN_NAME + '）');
  }
}
