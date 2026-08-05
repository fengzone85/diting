import { ref, watch } from 'vue';

type Theme = 'auto' | 'light' | 'dark';
const STORAGE_KEY = 'diting-theme';

function getInitialTheme(): Theme {
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
  return { theme, toggle, set };
}
