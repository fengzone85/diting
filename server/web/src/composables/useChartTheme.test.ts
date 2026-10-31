// useChartTheme：图表配色随 <html data-theme> 切换，靠 MutationObserver 跟随运行时变化。
// 该 composable 只在组件 onMounted 时注册监听，因此测试必须真实挂载/卸载组件。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp, defineComponent } from 'vue';
import { useChartTheme } from './useChartTheme';

let app: ReturnType<typeof createApp> | null = null;
let api: ReturnType<typeof useChartTheme>;

function mount() {
  const Comp = defineComponent({
    setup() {
      api = useChartTheme();
      return () => null;
    },
  });
  app = createApp(Comp);
  app.mount(document.createElement('div'));
}

// MutationObserver 回调是微任务，等一个宏任务确保已派发。
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('useChartTheme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it('无 data-theme 时按暗色给图表配色', () => {
    mount();
    expect(api.light.value).toBe(false);
    expect(api.colors.value).toEqual({
      text: '#94a3b8',
      splitLine: '#334155',
      axisLine: '#475569',
      tooltipBg: 'rgba(15, 23, 42, 0.95)',
      tooltipBorder: 'rgba(148, 163, 184, 0.2)',
    });
  });

  it('data-theme=light 时初始化即为亮色', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    mount();
    expect(api.light.value).toBe(true);
    expect(api.colors.value).toEqual({
      text: '#475569',
      splitLine: 'rgba(15, 23, 42, 0.08)',
      axisLine: 'rgba(15, 23, 42, 0.2)',
      tooltipBg: 'rgba(255, 255, 255, 0.95)',
      tooltipBorder: 'rgba(15, 23, 42, 0.12)',
    });
  });

  it('运行时切换 data-theme 会被监听并更新配色', async () => {
    mount();
    expect(api.light.value).toBe(false);

    document.documentElement.setAttribute('data-theme', 'light');
    await flush();
    expect(api.light.value).toBe(true);
    expect(api.colors.value.text).toBe('#475569');

    document.documentElement.removeAttribute('data-theme');
    await flush();
    expect(api.light.value).toBe(false);
    expect(api.colors.value.text).toBe('#94a3b8');
  });

  it('组件卸载后断开监听，不再跟随属性变化', async () => {
    mount();
    app!.unmount();
    app = null;

    document.documentElement.setAttribute('data-theme', 'light');
    await flush();
    expect(api.light.value).toBe(false);
  });
});
