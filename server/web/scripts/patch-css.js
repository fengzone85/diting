// Tailwind v4 + Vite esbuild minifier 会丢 .glass 规则的 backdrop-filter 标准属性，
// 只保留 -webkit-backdrop-filter。本脚本构建后自动补回标准属性。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, '../../public/assets');

if (!fs.existsSync(assetsDir)) {
  console.warn('[patch-css] assets dir not found:', assetsDir);
  process.exit(0);
}

const files = fs.readdirSync(assetsDir).filter((f) => /^index-.*\.css$/.test(f));
let patched = 0;
for (const f of files) {
  const p = path.join(assetsDir, f);
  let css = fs.readFileSync(p, 'utf8');
  const before = css;
  // 匹配独立的 .glass{...-webkit-backdrop-filter:...} 规则块（不匹配 [data-theme="light"] .glass）
  // 用 (?<![.\w-]) 避免匹配 .glass-card 之类的前缀
  const blockRegex = /(?<![.\w-])\.glass\s*\{([\s\S]*?)\}/g;
  css = css.replace(blockRegex, (m, body) => {
    if (!/webkit-backdrop-filter/i.test(body)) return m;
    if (/[^-]backdrop-filter\s*:/i.test(body)) return m; // 已有标准属性
    // 提取 webkit 行的值（去掉 -webkit- 前缀和 !important）
    const webkitLine = body.match(/(-webkit-backdrop-filter\s*:[^;]+);?/);
    if (!webkitLine) return m;
    const value = webkitLine[1].replace(/-webkit-backdrop-filter\s*:\s*/, '').replace(/\s*!important\s*$/, '').trim();
    // 把标准属性插在 webkit 行之前
    const newBody = body.replace(/(-webkit-backdrop-filter\s*:[^;]+;?)/, `backdrop-filter: ${value} !important;\n  $1`);
    return `.glass {${newBody}}`;
  });
  if (css !== before) {
    fs.writeFileSync(p, css);
    patched++;
    console.log(`[patch-css] patched ${f}`);
  }
}
console.log(`[patch-css] ${patched} file(s) patched`);
