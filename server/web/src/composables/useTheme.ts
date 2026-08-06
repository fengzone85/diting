import { ref, watch } from 'vue';
import { state, loadMeta } from '../composables/useApp';

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

function applyThemeAttr(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

// 将 meta 中的主题可视化配置应用到 <html> / 背景层（对齐 komari-theme-Glassmorphism）
function applyGlassConfig() {
  const root = document.documentElement;
  const m = state.meta;
  if (!m) return;
  // 毛玻璃预设
  const preset = m.glass_preset || 'emerald';
  root.setAttribute('data-glass', preset);
  // 自定义毛玻璃配色（5 色，light/dark）
  if (preset === 'custom' && m.glass_custom) {
    const isLight = root.getAttribute('data-theme') === 'light';
    const arr = (isLight ? m.glass_custom.light : m.glass_custom.dark) || [];
    if (arr.length >= 5) {
      root.style.setProperty('--glass-tint', arr[0]);
      root.style.setProperty('--glass-saturate', arr[1]);
      root.style.setProperty('--glass-blur', arr[2]);
      root.style.setProperty('--glass-border', arr[3]);
      root.style.setProperty('--glass-shadow', arr[4]);
    }
  } else {
    root.style.removeProperty('--glass-tint');
    root.style.removeProperty('--glass-saturate');
    root.style.removeProperty('--glass-blur');
    root.style.removeProperty('--glass-border');
    root.style.removeProperty('--glass-shadow');
  }
  // 色觉辅助
  const cv = m.color_vision || 'normal';
  if (cv === 'normal') root.removeAttribute('data-color-vision');
  else root.setAttribute('data-color-vision', cv);
  // 背景层
  applyBackground();
}

function applyBackground() {
  const m = state.meta;
  const root = document.documentElement;
  let layer = document.getElementById('app-bg');
  let overlay = document.getElementById('app-bg-overlay');
  const bg = m && m.background;
  if (bg && bg.enabled && bg.url) {
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'app-bg';
      layer.className = 'app-bg';
      document.body.appendChild(layer);
    }
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'app-bg-overlay';
      overlay.className = 'app-bg-overlay';
      document.body.appendChild(overlay);
    }
    const blur = `blur(${bg.blur || 0}px)`;
    if (bg.type === 'video') {
      layer.innerHTML = `<video autoplay muted loop playsinline style="filter:${blur}"><source src="${bg.url}"></video>`;
    } else {
      layer.innerHTML = '';
      layer.style.backgroundImage = `url("${bg.url}")`;
      layer.style.filter = blur;
    }
    const op = Math.max(0, Math.min(100, bg.overlay ?? 50)) / 100;
    overlay.style.background = `rgba(15,23,42,${op})`;
    overlay.style.opacity = '1';
    root.classList.add('has-bg');
  } else {
    if (layer) layer.remove();
    if (overlay) overlay.remove();
    root.classList.remove('has-bg');
  }
}

export const theme = ref<Theme>(getInitialTheme());
applyThemeAttr(theme.value);
applyGlassConfig();

watch(theme, (t) => {
  localStorage.setItem(STORAGE_KEY, t);
  applyThemeAttr(t);
  applyGlassConfig();
});

// meta 加载完成后重新应用（首屏 meta 可能晚于主题初始化）
if (!state.meta) {
  loadMeta().then(applyGlassConfig);
} else {
  applyGlassConfig();
}
watch(() => state.meta, () => applyGlassConfig());

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
  function refreshGlass() {
    applyGlassConfig();
  }
  return { theme, toggle, set, applyQueryPreview, refreshGlass };
}
