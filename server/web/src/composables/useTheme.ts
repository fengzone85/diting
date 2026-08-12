import { ref, watch } from 'vue';
import { state, loadMeta } from '../composables/useApp';

type Theme = 'auto' | 'light' | 'dark';
const STORAGE_KEY = 'diting-theme';

// 内置兜底背景（未配置任何背景时启用），随主题切换让毛玻璃更明显
const BG_DARK_FALLBACK =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'>" +
    "<defs><radialGradient id='g' cx='25%' cy='15%' r='130%'>" +
    "<stop offset='0' stop-color='#3b2a6b'/>" +
    "<stop offset='45%' stop-color='#1b1640'/>" +
    "<stop offset='100%' stop-color='#0a0a1a'/>" +
    "</radialGradient></defs><rect width='1920' height='1080' fill='url(#g)'/></svg>"
  );
const BG_LIGHT_FALLBACK =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'>" +
    "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
    "<stop offset='0' stop-color='#c9d6ff'/>" +
    "<stop offset='50%' stop-color='#e0c3fc'/>" +
    "<stop offset='100%' stop-color='#f5d9ff'/>" +
    "</linearGradient></defs><rect width='1920' height='1080' fill='url(#g)'/></svg>"
  );

function getInitialTheme(): Theme {
  // B4: ?theme= 预览优先于本地存储（用于分享/预览链接）
  const q = new URLSearchParams(window.location.search).get('theme');
  if (q === 'light' || q === 'dark' || q === 'auto') return q;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
  } catch { /* incognito */ }
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
  const m = state.meta as any;
  const root = document.documentElement;
  let layer = document.getElementById('app-bg');
  let overlay = document.getElementById('app-bg-overlay');
  // 按当前主题选用暗/亮背景配置（兼容旧版单 background 字段）
  const isLight = root.getAttribute('data-theme') === 'light';
  const bgDark = (m && m.background_dark) || (m && m.background) || null;
  const bgLight = (m && m.background_light) || null;
  let bg = isLight ? (bgLight || bgDark) : bgDark;
  // 兜底：未配置背景时，按主题注入内置蓝紫渐变，使毛玻璃卡片始终有色彩衬托
  if (!bg || !bg.enabled || !bg.url) {
    bg = isLight
      ? { enabled: true, type: 'image', url: BG_LIGHT_FALLBACK, blur: 0, overlay: 22 }
      : { enabled: true, type: 'image', url: BG_DARK_FALLBACK, blur: 0, overlay: 20 };
  }
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
    // 协议白名单：仅允许 http/https/data，阻止 javascript: 等危险协议
    const safeUrl = /^(https?:|data:)/i.test(bg.url) ? bg.url : '';
    const blur = `blur(${bg.blur || 0}px)`;
    if (bg.type === 'video' && safeUrl) {
      // 用 DOM API 替代 innerHTML 拼接，避免 XSS
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.style.filter = blur;
      const source = document.createElement('source');
      source.src = safeUrl;
      video.appendChild(source);
      layer.innerHTML = '';
      layer.appendChild(video);
    } else {
      layer.innerHTML = '';
      layer.style.backgroundImage = safeUrl ? `url("${safeUrl.replace(/"/g, '\\"')}")` : '';
      layer.style.filter = blur;
    }
    const op = Math.max(0, Math.min(100, bg.overlay ?? 50)) / 100;
    // 遮罩色随主题：暗色用深蓝压暗，亮色用浅灰保持明亮，避免亮色背景被深遮罩压灰
    const ovColor = isLight ? '226,232,240' : '15,23,42';
    overlay.style.background = `rgba(${ovColor},${op})`;
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
  try { localStorage.setItem(STORAGE_KEY, t); } catch { /* 无痕模式/配额满时忽略 */ }
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

// 供模板设置页保存后即时刷新主题
export function refreshGlass() {
  applyGlassConfig();
}
