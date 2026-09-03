// Tailwind v4 + Vite esbuild minifier 会丢 backdrop-filter 标准属性，
// 只保留 -webkit-backdrop-filter。本脚本构建后自动补回 .glass 规则。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, '../../public/assets');

if (!fs.existsSync(assetsDir)) {
  console.warn('[patch-css] assets dir not found:', assetsDir);
  process.exit(0);
}

function patchBlock(css, selectorRegex) {
  return css.replace(selectorRegex, (m, body) => {
    if (!/webkit-backdrop-filter/i.test(body)) return m;
    if (/[^-]backdrop-filter\s*:/i.test(body)) return m;
    const webkitLine = body.match(/(-webkit-backdrop-filter\s*:[^;]+);?/);
    if (!webkitLine) return m;
    const value = webkitLine[1].replace(/-webkit-backdrop-filter\s*:\s*/, '').replace(/\s*!important\s*$/, '').trim();
    const newBody = body.replace(/(-webkit-backdrop-filter\s*:[^;]+;?)/, `backdrop-filter: ${value} !important;\n  $1`);
    const sel = m.match(/^([^{]+)\{/)[1];
    return `${sel}{${newBody}}`;
  });
}

const files = fs.readdirSync(assetsDir).filter((f) => /^index-.*\.css$/.test(f));
let patched = 0;
for (const f of files) {
  const p = path.join(assetsDir, f);
  let css = fs.readFileSync(p, 'utf8');
  const before = css;

  // Patch .glass（不包括 [data-theme="light"] .glass 等变体）
  css = patchBlock(css, /(?<![.\w-])\.glass\s*\{([\s\S]*?)\}/g);

  if (css !== before) {
    fs.writeFileSync(p, css);
    patched++;
    console.log(`[patch-css] patched ${f}`);
  }
}
console.log(`[patch-css] ${patched} file(s) patched`);
