// i18n 覆盖守卫：扫描源码里所有静态 t('key')，断言键在中英词典中都存在且两边对齐。
//
// 为什么需要：t() 未命中时 useI18n 直接返回 key 本身，页面会出现
// 「settings.announcement」「settings.glassPreset」这类原始 key 且不报错，
// 类型检查也发现不了（键是字符串字面量）。模板设置页曾因此漏出 5 个键。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';

// vitest 的 cwd 是 web/；不用 import.meta.url（打包/转换后可能变成 root 相对路径）
const SRC_DIR = path.resolve(process.cwd(), 'src');
const I18N_DIR = path.join(SRC_DIR, 'utils', 'i18n');

// 只匹配静态字面量：t('a.b') / t("a.b")；t(`settings.${x}`) 这类动态键无法静态校验，跳过。
// 结尾要求紧跟 , 或 )：排除 t('node.range.' + x) 这类拼接出来的动态键。
const CALL_RE = /\bt\(\s*['"]([A-Za-z][\w.-]*)['"]\s*[,)]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.(vue|ts)$/.test(entry.name)) continue;
    if (/\.test\.ts$/.test(entry.name)) continue;
    if (full.startsWith(I18N_DIR)) continue;
    out.push(full);
  }
  return out;
}

function usedKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const file of walk(SRC_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(CALL_RE)) {
      const key = m[1];
      const rel = path.relative(SRC_DIR, file);
      const list = keys.get(key) || [];
      if (!list.includes(rel)) list.push(rel);
      keys.set(key, list);
    }
  }
  return keys;
}

describe('i18n 键覆盖', () => {
  const keys = usedKeys();

  it('源码中确实扫到了 t() 调用（防止正则失效导致空跑）', () => {
    expect(keys.size).toBeGreaterThan(100);
  });

  it('所有 t() 使用的中文词典键都存在', () => {
    const missing = [...keys.entries()]
      .filter(([k]) => !(k in zhCN))
      .map(([k, files]) => `${k} (${files.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('所有 t() 使用的英文词典键都存在', () => {
    const missing = [...keys.entries()]
      .filter(([k]) => !(k in enUS))
      .map(([k, files]) => `${k} (${files.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('中英词典键集合一致', () => {
    const onlyZh = Object.keys(zhCN).filter((k) => !(k in enUS));
    const onlyEn = Object.keys(enUS).filter((k) => !(k in zhCN));
    expect({ onlyZh, onlyEn }).toEqual({ onlyZh: [], onlyEn: [] });
  });
});
