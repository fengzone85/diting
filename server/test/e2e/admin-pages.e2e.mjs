// ============================================================
// 后台逐页冒烟：每个后台页面「能渲染 + 侧栏高亮唯一且正确 + 无 JS 异常」。
//
// 为什么需要它：后台页面在数据未就绪时会直接读 state.*（如 SettingsView 的
// local.ui.alert!.cpu_pct），冷加载/限流失败时整页渲染会抛 TypeError、只剩残缺 DOM。
// 纯单测发现不了这类问题，只有真正把页面打开才能暴露。
//
// 注意：服务端有全局限流（60 次 / 10s / IP），本脚本故意放慢节奏，
// 避免自己把门限打满（打满时会看到 429，页面应仍能渲染，只是数据为空）。
//
// 用法：
//   E2E_BASE_URL=https://192.168.0.6 E2E_PLAYWRIGHT_DIR=~/diting-e2e npm run e2e:pages
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..', '..');
const BASE = (process.env.E2E_BASE_URL || 'https://127.0.0.1').replace(/\/+$/, '');
const OUT_DIR = process.env.E2E_OUT_DIR || '';
const PAGE_GAP_MS = Number(process.env.E2E_PAGE_GAP_MS || 1200);

const log = (...a) => console.log('[e2e:pages]', ...a);

function readEnvFile(file) {
  try {
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trim().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  } catch { return {}; }
}

const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN || readEnvFile(path.join(SERVER_DIR, '.env')).ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) {
  console.error('[e2e:pages] 缺少管理员 Token：设置 E2E_ADMIN_TOKEN，或确保 server/.env 有 ADMIN_TOKEN。');
  process.exit(2);
}

async function loadPlaywright() {
  const dir = process.env.E2E_PLAYWRIGHT_DIR;
  try {
    if (dir) return createRequire(pathToFileURL(path.join(dir, 'noop.js')))('playwright');
    return await import('playwright');
  } catch (e) {
    console.error([
      '[e2e:pages] 找不到 playwright，请在仓库外安装后重试：',
      '  mkdir -p ~/diting-e2e && cd ~/diting-e2e && npm i playwright && npx playwright install chromium',
      '  E2E_PLAYWRIGHT_DIR=~/diting-e2e npm run e2e:pages',
      `  （原始错误：${e.message}）`,
    ].join('\n'));
    process.exit(2);
  }
}

const { chromium } = await loadPlaywright();

const PAGES = [
  ['/admin', '仪表盘'],
  ['/admin/agents', '受控端'],
  ['/admin/billing', '账单概览'],
  ['/admin/ai', 'AI 运维分析'],
  ['/admin/audit-logs', '审计日志'],
  ['/admin/api-tokens', 'API Token'],
  ['/admin/settings', '设置'],
  ['/admin/template', '模板设置'],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e));
// 429/401 等网络状态会被浏览器记成 "Failed to load resource"，属预期噪声；
// 真正的 JS 异常才算失败。
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });

let failed = 0;
try {
  await page.goto(BASE + '/login');
  await page.fill('input[type=password]', ADMIN_TOKEN);
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin**', { timeout: 20000 });

  for (const [pathname, expectLabel] of PAGES) {
    const before = errs.length;
    await page.goto(BASE + pathname);
    await page.waitForSelector('aside.sidebar', { timeout: 15000 });
    await page.waitForTimeout(700);

    const active = page.locator('aside a.bg-sky-500\\/20');
    const n = await active.count();
    const label = n === 1 ? ((await active.first().textContent()) || '').trim() : '';
    const newErrs = errs.slice(before);
    const ok = n === 1 && label.includes(expectLabel) && newErrs.length === 0;
    if (!ok) failed++;
    log(`${ok ? 'OK ' : 'BAD'} ${pathname.padEnd(20)} active=${n} "${label}"${newErrs.length ? ' err=' + newErrs.join(' | ') : ''}`);
    if (OUT_DIR) {
      await page.screenshot({ path: path.join(OUT_DIR, 'page-' + pathname.replace(/\//g, '_') + '.png') });
    }
    await page.waitForTimeout(PAGE_GAP_MS);
  }

  // 收起态跨页保持
  await page.locator('aside button[title="收起侧栏"]').click();
  await page.waitForTimeout(300);
  await page.goto(BASE + '/admin/settings');
  await page.waitForTimeout(600);
  const w = Math.round((await page.locator('aside.sidebar').boundingBox())?.width || 0);
  const kept = w < 120;
  if (!kept) failed++;
  log('收起态跨页保持:', kept ? 'OK' : 'BAD', w + 'px');

  if (failed) {
    console.error(`\nE2E PAGES FAIL (${failed})`);
    process.exitCode = 1;
  } else {
    console.log('\nE2E PAGES PASS');
  }
} catch (e) {
  console.error('\nE2E PAGES FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
