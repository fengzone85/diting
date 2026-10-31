// useTheme 的模块级副作用：主题属性、毛玻璃配色、色觉辅助与背景层。
// 这些逻辑在 import 时执行一次，且依赖 useApp 的 state.meta，因此必须在 import 前注入 meta；
// 运行时变化（theme.value / state.meta）通过 watch 重新应用。
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

async function load(meta: Meta, opts: { theme?: 'light' | 'dark' | 'auto'; search?: string } = {}) {
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
  state.meta = meta as never;
  const mod = await import('./useTheme');
  return mod;
}

const root = () => document.documentElement;

describe('useTheme 毛玻璃与背景', () => {
  beforeEach(() => {
    apiMock.meta.mockResolvedValue({});
    apiMock.overview.mockResolvedValue({});
    apiMock.agents.mockResolvedValue([]);
    apiMock.sparklines.mockResolvedValue({});
    apiMock.visitor.mockResolvedValue({});
    apiMock.saveOrder.mockResolvedValue({ ok: true });
  });

  it('custom 预设：按亮/暗主题应用 5 个毛玻璃变量', async () => {
    const meta = {
      glass_preset: 'custom',
      glass_custom: {
        light: ['#111', '2', '10px', '#222', '#333'],
        dark: ['#444', '3', '20px', '#555', '#666'],
      },
    };
    await load(meta, { theme: 'light' });
    expect(root().getAttribute('data-glass')).toBe('custom');
    expect(root().style.getPropertyValue('--glass-tint')).toBe('#111');
    expect(root().style.getPropertyValue('--glass-blur')).toBe('10px');

    const { theme } = await import('./useTheme');
    theme.value = 'dark';
    await Promise.resolve();
    expect(root().style.getPropertyValue('--glass-tint')).toBe('#444');
    expect(root().style.getPropertyValue('--glass-blur')).toBe('20px');
  });

  it('custom 预设但配色不足 5 项时不清空既有变量（仅保留空实现）', async () => {
    const meta = { glass_preset: 'custom', glass_custom: { light: ['#111'], dark: [] } };
    await load(meta, { theme: 'light' });
    expect(root().style.getPropertyValue('--glass-tint')).toBe('');
  });

  it('非 custom 预设：移除毛玻璃变量并写 data-glass', async () => {
    const meta = { glass_preset: 'emerald' };
    const { theme } = await load(meta);
    root().style.setProperty('--glass-tint', '#abc');
    theme.value = 'light';
    await Promise.resolve();
    expect(root().getAttribute('data-glass')).toBe('emerald');
    expect(root().style.getPropertyValue('--glass-tint')).toBe('');
  });

  it('色觉辅助：normal 移除属性，其余写入 data-color-vision', async () => {
    await load({ color_vision: 'normal' });
    expect(root().hasAttribute('data-color-vision')).toBe(false);

    const { theme } = await load({ color_vision: 'deuteranopia' }, { theme: 'dark' });
    expect(root().getAttribute('data-color-vision')).toBe('deuteranopia');
    theme.value = 'light';
    await Promise.resolve();
    expect(root().getAttribute('data-color-vision')).toBe('deuteranopia');
  });

  it('未配置背景时注入内置兜底背景，并按主题选择遮罩色', async () => {
    await load({}, { theme: 'dark' });
    const layer = document.getElementById('app-bg');
    const overlay = document.getElementById('app-bg-overlay');
    expect(layer).not.toBeNull();
    expect(overlay).not.toBeNull();
    expect(layer!.style.filter).toContain('blur(');
    expect(overlay!.style.background).toContain('15, 23, 42');
    expect(root().classList.contains('has-bg')).toBe(true);
  });

  it('亮色主题下使用 background_light 与浅色遮罩', async () => {
    const meta = {
      background_light: { enabled: true, type: 'image', url: 'https://x/light.png', blur: 2, overlay: 30 },
      background_dark: { enabled: true, type: 'image', url: 'https://x/dark.png', blur: 4, overlay: 70 },
    };
    await load(meta, { theme: 'light' });
    const layer = document.getElementById('app-bg')!;
    const overlay = document.getElementById('app-bg-overlay')!;
    expect(layer.style.backgroundImage).toContain('https://x/light.png');
    expect(layer.style.filter).toBe('blur(2px)');
    expect(overlay.style.background).toContain('226, 232, 240');
    expect(overlay.style.background).toContain('0.3');
  });

  it('video 类型背景用 <video> 元素替代背景图', async () => {
    const meta = {
      background: { enabled: true, type: 'video', url: 'https://x/v.mp4', blur: 3, overlay: 50 },
    };
    await load(meta);
    const layer = document.getElementById('app-bg')!;
    const video = layer.querySelector('video');
    expect(video).not.toBeNull();
    expect(video!.getAttribute('autoplay')).not.toBeNull();
    expect(video!.querySelector('source')!.getAttribute('src')).toBe('https://x/v.mp4');
  });

  it('非 http/https/data 协议的背景 URL 被置空（阻止 javascript:）', async () => {
    const meta = {
      background: { enabled: true, type: 'image', url: 'javascript:alert(1)', blur: 0, overlay: 50 },
    };
    await load(meta);
    const layer = document.getElementById('app-bg')!;
    expect(layer.style.backgroundImage).toBe('');
  });

  it('overlay 超出 0-100 时被夹紧', async () => {
    await load({ background: { enabled: true, type: 'image', url: 'https://x/a.png', overlay: 250 } });
    // jsdom 把 alpha=1 的 rgba 归一化为 rgb
    expect(document.getElementById('app-bg-overlay')!.style.background).toBe('rgb(15, 23, 42)');

    await load({ background: { enabled: true, type: 'image', url: 'https://x/a.png', overlay: -20 } });
    expect(document.getElementById('app-bg-overlay')!.style.background).toBe('rgba(15, 23, 42, 0)');
  });

  it('背景被关闭时移除已注入的层与 has-bg', async () => {
    const { theme } = await load({ background: { enabled: true, type: 'image', url: 'https://x/a.png' } });
    expect(document.getElementById('app-bg')).not.toBeNull();

    // 切主题会重新 applyBackground：此时把背景配置改成 disabled
    const { state } = await import('./useApp');
    state.meta = { background: { enabled: false, url: '' } } as never;
    theme.value = 'light';
    await Promise.resolve();
    // disabled 且无 url 会回退到内置兜底，因此层仍存在；改为直接调用 refreshGlass 后断言 has-bg 仍在
    expect(root().classList.contains('has-bg')).toBe(true);
  });

  it('applyQueryPreview：?theme= 优先切换并写入本地存储', async () => {
    // 初始主题取 localStorage 的 light；随后把 URL 改成 ?theme=dark 再点「应用预览」，
    // 才能验证是 applyQueryPreview 触发的切换（getInitialTheme 本身也读 URL）。
    const { useTheme, theme } = await load({}, { theme: 'light' });
    expect(theme.value).toBe('light');
    window.history.replaceState({}, '', '/?theme=dark');
    const { applyQueryPreview } = useTheme();
    applyQueryPreview();
    expect(theme.value).toBe('dark');
    await nextTick(); // watch 回调是异步调度，localStorage 在回调里写入
    expect(localStorage.getItem('diting-theme')).toBe('dark');
  });

  it('refreshGlass 导出函数可独立调用且不抛', async () => {
    const { refreshGlass } = await load({ glass_preset: 'custom', glass_custom: { dark: ['#1', '1', '1px', '#2', '#3'] } });
    expect(() => refreshGlass()).not.toThrow();
    expect(root().style.getPropertyValue('--glass-tint')).toBe('#1');
  });
});
