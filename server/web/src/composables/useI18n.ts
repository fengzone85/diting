import { ref } from 'vue';
import { zhCN } from '../utils/i18n/zh-CN';
import { enUS } from '../utils/i18n/en-US';

export type Locale = 'zh-CN' | 'en-US';

const dictionaries: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

function detectLocale(): Locale {
  const stored = localStorage.getItem('diting.lang');
  if (stored === 'zh-CN' || stored === 'en-US') return stored;
  const nav = navigator.language || '';
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export const locale = ref<Locale>(detectLocale());

function lookup(key: string): string {
  return dictionaries[locale.value][key] ?? dictionaries['zh-CN'][key] ?? key;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let str = lookup(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return str;
}

export function setLocale(next: Locale) {
  locale.value = next;
  localStorage.setItem('diting.lang', next);
  document.documentElement.lang = next === 'zh-CN' ? 'zh-CN' : 'en';
}

export function useI18n() {
  return { t, locale, setLocale };
}
