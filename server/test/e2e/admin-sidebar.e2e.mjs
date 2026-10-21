// ============================================================
// 后台侧栏端到端回归（参考 Komari 的分组菜单 + 可收起图标轨）
//
// 覆盖：
//   - 分组标题（监控 / 运维 / 系统）与「返回主页」入口存在；
//   - 桌面端收起 → 宽度降为图标轨、文案隐藏；刷新后保持（localStorage）；
//   - 展开 → 恢复 15rem；
//   - 长页面下「返回主页 / 退出」固定在视口内（sticky 满高侧栏）；
//   - 「返回主页」跳转公开首页；
//   - 移动端（390px）抽屉全宽可用。
//
// 使用（Playwright 需在仓库外安装，理由见 api-tokens.e2e.mjs 头注释）：
//   E2E_BASE_URL=https://192.168.0.6 E2E_PLAYWRIGHT_DIR=~/diting-e2e npm run e2e:menu
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..', '..');
const BASE = (process.env.E2E_BASE_URL || 'https://127.0.0.1').replace(/\/+$/, '');
const OUT_DIR = process.env.E2E_OUT_DIR || '';

const log = (...a) => console.log('[e2e:menu]', ...a);
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };

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
  console.error('[e2e:menu] 缺少管理员 Token：设置 E2E_ADMIN_TOKEN，或确保 server/.env 有 ADMIN_TOKEN。');
  process.exit(2);
}

async function loadPlaywright() {
  const dir = process.env.E2E_PLAYWRIGHT_DIR;
  try {
    if (dir) return createRequire(pathToFileURL(path.join(dir, 'noop.js')))('playwright');
    return await import('playwright');
  } catch (e) {
    console.error([
      '[e2e:menu] 找不到 playwright，请在仓库外安装后重试：',
      '  mkdir -p ~/diting-e2e && cd ~/diting-e2e && npm i playwright && npx playwright install chromium',
      '  E2E_PLAYWRIGHT_DIR=~/diting-e2e npm run e2e:menu',
      `  （原始错误：${e.message}）`,
    ].join('\n'));
    process.exit(2);
  }
}

const { chromium } = await loadPlaywright();
const shot = async (page, name) => {
  if (!OUT_DIR) return;
  await page.screenshot({ path: path.join(OUT_DIR, name) });
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });

async function login(p) {
  await p.goto(BASE + '/login');
  await p.fill('input[type=password]', ADMIN_TOKEN);
  await p.click('button[type=submit]');
  await p.waitForURL('**/admin**', { timeout: 20000 });
}

try {
  await login(page);
  const aside = page.locator('aside.sidebar');
  const width = async () => Math.round((await aside.boundingBox())?.width || 0);

  assert(await width() >= 200, '默认应为展开态（15rem），实际 ' + await width());
  for (const txt of ['监控', '运维', '系统']) {
    assert(await aside.locator('.group-title', { hasText: txt }).count() === 1, `缺少分组标题「${txt}」`);
  }
  assert(await aside.locator('a[href="/"]').count() === 1, '缺少「返回主页」入口');
  assert(await aside.locator('a[href="/admin/api-tokens"]').count() === 1, '缺少 API Token 菜单项');

  const homeBox = await aside.locator('a[href="/"]').boundingBox();
  const vp = page.viewportSize();
  assert(homeBox && homeBox.y + homeBox.height <= vp.height, '「返回主页」应停留在视口内');
  await shot(page, 'menu-expanded.png');

  // 收起 → 图标轨
  await aside.locator('button[title="收起侧栏"]').click();
  await page.waitForTimeout(400);
  const wCollapsed = await width();
  assert(wCollapsed < 120, '收起后应为图标轨，实际 ' + wCollapsed);
  assert(!(await aside.locator('.label').first().isVisible()), '收起后文案应隐藏');

  // 收起后：「D」字标与站名隐藏，收起/展开按钮顶替其位置并水平居中（对齐 Komari），
  // 二者不得同时出现（此前会与 D 字重叠）。
  assert(!(await aside.locator('.brand').isVisible()), '收起后品牌区应隐藏');
  const toggle = aside.locator('.collapse-toggle');
  assert(await toggle.isVisible(), '收起后展开按钮应可见');
  const ab = await aside.boundingBox();
  const tb = await toggle.boundingBox();
  assert(tb && ab && Math.abs((tb.x + tb.width / 2) - (ab.x + ab.width / 2)) <= 4,
    `收起态按钮应居中于侧栏（侧栏 ${Math.round(ab.width)}px，按钮中心偏移 ${tb ? Math.round(tb.x + tb.width / 2 - (ab.x + ab.width / 2)) : 'n/a'}px）`);
  await shot(page, 'menu-collapsed.png');

  // 刷新后保持收起
  await page.reload();
  await page.waitForSelector('aside.sidebar');
  await page.waitForTimeout(300);
  assert(await width() < 120, '刷新后应保持收起，实际 ' + await width());

  // 展开回 15rem
  await page.locator('aside button[title="展开侧栏"]').click();
  await page.waitForTimeout(300);
  assert(await width() >= 200, '应能重新展开');

  // 返回主页
  await page.locator('aside a[href="/"]').click();
  await page.waitForURL(BASE + '/', { timeout: 15000 });
  log('返回主页 OK');

  // 移动端抽屉
  const mctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'zh-CN', viewport: { width: 390, height: 844 } });
  const mp = await mctx.newPage();
  await login(mp);
  await mp.locator('main button.lg\\:hidden').first().click();
  await mp.waitForTimeout(400);
  const mw = Math.round((await mp.locator('aside.sidebar').boundingBox())?.width || 0);
  assert(mw >= 200, '移动端抽屉应全宽，实际 ' + mw);
  await shot(mp, 'menu-mobile.png');
  await mctx.close();

  // 回归：桌面端收起过（localStorage=1）后打开移动端抽屉，
  // 菜单仍必须左对齐、有内边距——收起态的「居中 + 零内边距」规则只能作用于桌面。
  const cctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'zh-CN', viewport: { width: 390, height: 844 } });
  await cctx.addInitScript(() => localStorage.setItem('diting.admin.sidebar.collapsed', '1'));
  const cp = await cctx.newPage();
  await login(cp);
  await cp.locator('main button.lg\\:hidden').first().click();
  await cp.waitForTimeout(400);
  const linkStyle = await cp.locator('aside a[href="/admin/agents"]').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { justify: cs.justifyContent, paddingLeft: cs.paddingLeft, labelVisible: !!el.querySelector('.label')?.getBoundingClientRect().width };
  });
  assert(linkStyle.justify !== 'center', '移动端抽屉不应继承收起态居中，实际 ' + linkStyle.justify);
  assert(linkStyle.paddingLeft !== '0px', '移动端抽屉不应继承零内边距，实际 ' + linkStyle.paddingLeft);
  assert(linkStyle.labelVisible > 0, '移动端抽屉应显示菜单文案');
  await shot(cp, 'menu-mobile-collapsed-flag.png');
  await cctx.close();

  assert(errs.length === 0, '页面报错: ' + errs.join(' | '));
  console.log('\nE2E MENU PASS');
} catch (e) {
  console.error('\nE2E MENU FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
