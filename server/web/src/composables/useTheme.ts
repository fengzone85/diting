import { ref, watch } from 'vue';

type Theme = 'auto' | 'light' | 'dark';
const STORAGE_KEY = 'diting-theme';

function getInitialTheme(): Theme {
  // B4: ?theme= 预览优先于本地存储（用于分享/预览链接）
  const q = new URLSearchParams(window.location.search).get('theme');
  if (q === 'light' || q === 'dark' || q === 'auto') return q;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
  return 'auto';
}

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

export const theme = ref<Theme>(getInitialTheme());
apply(theme.value);

watch(theme, (t) => {
  localStorage.setItem(STORAGE_KEY, t);
  apply(t);
});

export function useTheme() {
  function toggle() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }
  function set(value: Theme) {
    theme.value = value;
  }
  // 从 ?theme= 预览并持久化到本地（设置页"应用此预览"按钮调用）
  function applyQueryPreview() {
    const q = new URLSearchParams(window.location.search).get('theme');
    if (q === 'light' || q === 'dark' || q === 'auto') {
      theme.value = q;
    }
  }
  return { theme, toggle, set, applyQueryPreview };
}
