import { ref, watch } from 'vue';
import { state, loadMeta } from '../composables/useApp';

type Theme = 'auto' | 'light' | 'dark';
const STORAGE_KEY = 'diting-theme';

// 内置兜底背景（未配置任何背景时启用）：对齐玻璃拟态设计的多层 aurora 光斑。
// 暗色深靛黑底 + 紫/靛/青/洋红四角柔光；亮色浅冷白底 + 蓝紫/粉/青柔光。
// 与 main.css 的 body 渐变、TemplateView 的默认背景保持同色系（三处口径一致）。
const BG_DARK_FALLBACK =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'>" +
    "<defs>" +
    "<radialGradient id='a'><stop offset='0' stop-color='#7c3aed' stop-opacity='.55'/><stop offset='1' stop-color='#7c3aed' stop-opacity='0'/></radialGradient>" +
    "<radialGradient id='b'><stop offset='0' stop-color='#3b6bff' stop-opacity='.45'/><stop offset='1' stop-color='#3b6bff' stop-opacity='0'/></radialGradient>" +
    "<radialGradient id='c'><stop offset='0' stop-color='#14b8a6' stop-opacity='.35'/><stop offset='1' stop-color='#14b8a6' stop-opacity='0'/></radialGradient>" +
    "<radialGradient id='d'><stop offset='0' stop-color='#a855f7' stop-opacity='.28'/><stop offset='1' stop-color='#a855f7' stop-opacity='0'/></radialGradient>" +
    "</defs>" +
    "<rect width='1920' height='1080' fill='#070b18'/>" +
    "<ellipse cx='300' cy='120' rx='950' ry='760' fill='url(#a)'/>" +
    "<ellipse cx='1750' cy='180' rx='820' ry='640' fill='url(#b)'/>" +
    "<ellipse cx='1580' cy='1010' rx='900' ry='720' fill='url(#c)'/>" +
    "<ellipse cx='160' cy='980' rx='720' ry='600' fill='url(#d)'/>" +
    "</svg>"
  );
const BG_LIGHT_FALLBACK =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'>" +
    "<defs>" +
    "<radialGradient id='a'><stop offset='0' stop-color='#a78bfa' stop-opacity='.55'/><stop offset='1' stop-color='#a78bfa' stop-opacity='0'/></radialGradient>" +
    "<radialGradient id='b'><stop offset='0' stop-color='#f472b6' stop-opacity='.42'/><stop offset='1' stop-color='#f472b6' stop-opacity='0'/></radialGradient>" +
    "<radialGradient id='c'><stop offset='0' stop-color='#67e8f9' stop-opacity='.50'/><stop offset='1' stop-color='#67e8f9' stop-opacity='0'/></radialGradient>" +
    "<radialGradient id='d'><stop offset='0' stop-color='#c7d2fe' stop-opacity='.60'/><stop offset='1' stop-color='#c7d2fe' stop-opacity='0'/></radialGradient>" +
    "</defs>" +
    "<rect width='1920' height='1080' fill='#eef2f9'/>" +
    "<ellipse cx='240' cy='60' rx='1000' ry='780' fill='url(#d)'/>" +
    "<ellipse cx='1780' cy='140' rx='800' ry='620' fill='url(#b)'/>" +
    "<ellipse cx='1620' cy='1020' rx='880' ry='700' fill='url(#c)'/>" +
    "<ellipse cx='420' cy='260' rx='760' ry='620' fill='url(#a)'/>" +
    "</svg>"
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

// 将 meta 中的主题可视化配置应用到 <html> / 背景层（对齐玻璃拟态主题）
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
  // 兜底：未配置背景时注入内置 aurora 光斑，使毛玻璃卡片始终有色彩衬托。
  // overlay 从 20/22 降到 10/8：新光斑本身已柔和，过厚遮罩会把色彩压回灰蒙蒙一片。
  if (!bg || !bg.enabled || !bg.url) {
    bg = isLight
      ? { enabled: true, type: 'image', url: BG_LIGHT_FALLBACK, blur: 0, overlay: 8 }
      : { enabled: true, type: 'image', url: BG_DARK_FALLBACK, blur: 0, overlay: 10 };
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
