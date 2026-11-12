// useTheme 行为面：主题初始化/切换、玻璃配色、背景层与 URL 安全白名单。
// 模块带 import 时副作用（读 URL/本地存储并写 DOM），每例先重置环境再动态 import。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';

const apiMock = vi.hoisted(() => ({
  overview: vi.fn(),
  agents: vi.fn(),
  meta: vi.fn(),
  sparklines: vi.fn(),
  visitor: vi.fn(),
  saveOrder: vi.fn(),
}));

vi.mock('../services/publicApi', () => ({ publicApi: apiMock }));

type Meta = Record<string, unknown>;

async function load(meta: Meta | null, opts: { theme?: 'light' | 'dark' | 'auto'; search?: string } = {}) {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-glass');
  document.documentElement.removeAttribute('data-color-vision');
  document.documentElement.removeAttribute('style');
  document.body.innerHTML = '';
  if (opts.theme) localStorage.setItem('diting-theme', opts.theme);
  window.history.replaceState({}, '', opts.search ? `/?${opts.search}` : '/');
  const { state } = await import('./useApp');
  if (meta) state.meta = meta as never;
  return import('./useTheme');
}

const root = () => document.documentElement;

describe('useTheme 行为面', () => {
  beforeEach(() => {
    apiMock.meta.mockResolvedValue({});
    apiMock.overview.mockResolvedValue({});
    apiMock.agents.mockResolvedValue([]);
    apiMock.sparklines.mockResolvedValue({});
    apiMock.visitor.mockResolvedValue({});
    apiMock.saveOrder.mockResolvedValue({ ok: true });
  });

  it('初始主题：?theme= 预览优先于本地存储，非法查询值被忽略', async () => {
    const { theme } = await load(null, { search: 'theme=light' });
    expect(theme.value).toBe('light');

    const mod = await load(null, { search: 'theme=rainbow', theme: 'dark' });
    expect(mod.theme.value).toBe('dark');
  });

  it('初始主题：本地存储非法值或不可读时回退 auto', async () => {
    localStorage.setItem('diting-theme', 'neon');
    const { theme } = await load(null);
    expect(theme.value).toBe('auto');

    // 只让 diting-theme 这个键抛错（useApp 自身的本地存储读取不能被波及）
    const orig = Storage.prototype.getItem;
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === 'diting-theme') throw new Error('blocked');
      return orig.call(this, key);
    });
    try {
      const mod = await load(null);
      expect(mod.theme.value).toBe('auto');
    } finally {
      getItem.mockRestore();
    }
    const later = await load(null, { theme: 'dark' });
    expect(later.theme.value).toBe('dark');
  });

  it('主题属性：auto 移除 data-theme，light/dark 写入并持久化', async () => {
    const { theme, useTheme } = await load(null, { theme: 'auto' });
    expect(root().hasAttribute('data-theme')).toBe(false);
    const { set } = useTheme();
    set('dark');
    await nextTick();
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('diting-theme')).toBe('dark');
    theme.value = 'auto';
    await nextTick();
    expect(root().hasAttribute('data-theme')).toBe(false);
  });

  it('玻璃配色：默认预设 emerald；custom 按主题写 5 变量；配色不足 5 项不落变量', async () => {
    await load({});
    expect(root().getAttribute('data-glass')).toBe('emerald');

    const mod = await load(
      {
        glass_preset: 'custom',
        glass_custom: {
          light: ['#111', '1', '2px', '#222', '#333'],
          dark: ['#444', '4', '5px', '#555', '#666'],
        },
      },
      { theme: 'light' },
    );
    expect(root().style.getPropertyValue('--glass-tint')).toBe('#111');
    expect(root().style.getPropertyValue('--glass-blur')).toBe('2px');
    mod.theme.value = 'dark';
    await nextTick();
    expect(root().style.getPropertyValue('--glass-tint')).toBe('#444');
    expect(root().style.getPropertyValue('--glass-blur')).toBe('5px');

    await load({ glass_preset: 'custom', glass_custom: { light: ['#999'], dark: ['#999'] } }, { theme: 'light' });
    expect(root().style.getPropertyValue('--glass-tint')).toBe('');

    await load({ glass_preset: 'custom' }, { theme: 'light' });
    expect(root().style.getPropertyValue('--glass-tint')).toBe('');
  });

  it('色觉辅助：normal 移除属性，其余写入 data-color-vision', async () => {
    await load({ color_vision: 'protanopia' });
    expect(root().getAttribute('data-color-vision')).toBe('protanopia');
    await load({});
    expect(root().hasAttribute('data-color-vision')).toBe(false);
  });

  it('背景层：video 走 <video> 元素，图片走 background-image，遮罩按 overlay 计算', async () => {
    await load({ background: { enabled: true, type: 'video', url: 'https://cdn/v.mp4', blur: 2 } });
    const layer = document.getElementById('app-bg')!;
    const video = layer.querySelector('video');
    expect(video).not.toBeNull();
    expect(video!.querySelector('source')!.getAttribute('src')).toBe('https://cdn/v.mp4');
    expect(video!.style.filter).toBe('blur(2px)');

    await load({ background: { enabled: true, type: 'image', url: 'https://cdn/i.png', blur: 3, overlay: 40 } });
    const img = document.getElementById('app-bg')!;
    expect(img.style.backgroundImage).toContain('https://cdn/i.png');
    expect(img.style.filter).toBe('blur(3px)');
    expect(document.getElementById('app-bg-overlay')!.style.background).toContain('0.4');
  });

  it('URL 安全白名单：仅 http/https/data 放行，危险协议在图片与 video 两条路径都被清空', async () => {
    await load({ background: { enabled: true, type: 'image', url: 'javascript:alert(1)' } });
    expect(document.getElementById('app-bg')!.style.backgroundImage).toBe('');

    await load({ background: { enabled: true, type: 'image', url: 'data:image/gif;base64,R0lGOD' } });
    expect(document.getElementById('app-bg')!.style.backgroundImage).toContain('data:image/gif');

    await load({ background: { enabled: true, type: 'video', url: 'vbscript:evil' } });
    const layer = document.getElementById('app-bg')!;
    expect(layer.querySelector('video')).toBeNull();
    expect(layer.style.backgroundImage).toBe('');
  });

  it('遮罩：越界 overlay 夹紧到 0-100，缺省 50，亮暗用不同遮罩色', async () => {
    await load({ background_dark: { enabled: true, type: 'image', url: 'https://x/b.png', overlay: 250 } }, { theme: 'dark' });
    expect(document.getElementById('app-bg-overlay')!.style.background).toBe('rgb(15, 23, 42)');

    await load({ background_light: { enabled: true, type: 'image', url: 'https://x/b.png', overlay: -5 } }, { theme: 'light' });
    expect(document.getElementById('app-bg-overlay')!.style.background).toBe('rgba(226, 232, 240, 0)');

    await load({ background: { enabled: true, type: 'image', url: 'https://x/b.png' } });
    expect(document.getElementById('app-bg-overlay')!.style.background).toContain('0.5');
  });

  it('未配置背景注入内置衬底；旧单字段 background 兼容；亮色缺 background_light 回落暗色配置', async () => {
    const { theme } = await load({ background: { enabled: true, type: 'image', url: 'https://x/old.png' } }, { theme: 'dark' });
    const layer = document.getElementById('app-bg');
    expect(layer).not.toBeNull();
    expect(root().classList.contains('has-bg')).toBe(true);

    const { state } = await import('./useApp');
    state.meta = {
      background_dark: { enabled: true, type: 'image', url: 'https://x/d.png' },
    } as never;
    theme.value = 'light';
    await nextTick();
    expect(document.getElementById('app-bg')).toBe(layer);
    expect(layer.style.backgroundImage).toContain('https://x/d.png');
  });

  it('meta 晚到走 loadMeta 异步应用；state.meta 变化触发重绘', async () => {
    apiMock.meta.mockResolvedValue({ glass_preset: 'ocean' });
    const { theme } = await load(null);
    await vi.waitFor(() => expect(root().getAttribute('data-glass')).toBe('ocean'));

    const { state } = await import('./useApp');
    state.meta = { color_vision: 'tritanopia' } as never;
    theme.value = 'dark';
    await nextTick();
    expect(root().getAttribute('data-color-vision')).toBe('tritanopia');
  });

  it('applyQueryPreview：合法 ?theme= 切换主题，非法值不动', async () => {
    const { useTheme, theme } = await load({}, { theme: 'light' });
    window.history.replaceState({}, '', '/?theme=sepia');
    useTheme().applyQueryPreview();
    expect(theme.value).toBe('light');

    window.history.replaceState({}, '', '/?theme=auto');
    useTheme().applyQueryPreview();
    expect(theme.value).toBe('auto');
  });

  it('refreshGlass 与 useTheme().refreshGlass 均可独立重绘', async () => {
    const mod = await load({ glass_preset: 'custom', glass_custom: { dark: ['#1', '1', '1px', '#2', '#3'] } }, { theme: 'dark' });
    expect(root().style.getPropertyValue('--glass-tint')).toBe('#1');
    root().style.removeProperty('--glass-tint');
    mod.refreshGlass();
    expect(root().style.getPropertyValue('--glass-tint')).toBe('#1');
    root().style.removeProperty('--glass-tint');
    mod.useTheme().refreshGlass();
    expect(root().style.getPropertyValue('--glass-tint')).toBe('#1');
  });
});
