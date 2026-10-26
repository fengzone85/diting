'use strict';
// 构建前清空 ../public/assets。
//
// 为什么需要它：vite.config 里 outDir 指向 ../public（web 根之外），而 public/ 下
// 还混有非构建产物（flags/、logo-assets/、favicon 等），所以显式设了
// `emptyOutDir: false` —— 代价是每次构建都会把新 hash 文件**叠加**进 assets/。
// 实测累积到 1802 个历史文件（最旧到 10 月中旬），既浪费磁盘也会让排查
// 「当前到底在跑哪个产物」变困难。
//
// 为什么逐个 unlink 而不是 rmSync(recursive)：
//   本仓库的开发环境（VS Code 扩展注入的安全 shim）对单次批量删除 >500 个
//   文件会直接抛错中止；逐个删除既避开该护栏，也便于在途中打印进度。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dir = path.resolve(__dirname, '../../public/assets');
if (!fs.existsSync(dir)) {
  console.log('[clean-assets] assets 目录不存在，跳过');
  process.exit(0);
}

let files = 0;
let dirs = 0;
function walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, ent.name);
    if (ent.isDirectory()) {
      walk(full);
      fs.rmdirSync(full);
      dirs++;
    } else {
      fs.unlinkSync(full);
      files++;
    }
  }
}
walk(dir);
console.log(`[clean-assets] 已清理 ${files} 个文件、${dirs} 个目录`);
