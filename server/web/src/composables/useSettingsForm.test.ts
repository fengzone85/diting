// 回归测试：设置页「回填服务端配置」与「dirty 标记」的注册顺序。
//
// 背景（真实 bug，2026-09-12 修复）：SettingsView 原先先注册
//   watch(local, () => dirty = true)
// 再执行 resetLocal() 与 watch(state.settings, 回填)。
// 由于 watch 默认 flush:'pre'，resetLocal() 触发的 dirty 会在 setup 结束后才置真，
// 于是服务端设置到达时回填被 `if (dirty) return` 拦掉 —— 冷加载（刷新设置页）
// 显示默认值，此时点保存会用残缺表单覆盖服务端已存配置（site_title 等被清空）。
//
// 这里把两个 watch 的注册封装为工厂，并用 testOrder 断言顺序语义，
// 防止未来又被改回去。
import { describe, it, expect } from 'vitest';
import { ref, watch, nextTick } from 'vue';

interface SettingsShape {
  ui: Record<string, unknown>;
  notify: Record<string, unknown>;
}

// 与 SettingsView 等价的表单装配逻辑，order 控制 watch 注册顺序
function setupForm(order: 'correct' | 'buggy') {
  const dirty = ref(false);
  const local = ref<SettingsShape>({ ui: {}, notify: {} });
  const settings = ref<{ ui: Record<string, unknown> } | null>(null);

  const registerDirtyWatch = () => watch(local, () => { dirty.value = true; }, { deep: true });
  const resetLocal = () => {
    local.value = { ui: { backup_schedule: 'off', backup_hour: 3, backup_keep_days: 14 }, notify: {} };
  };
  const registerFillWatch = () => watch(settings, (s) => {
    if (dirty.value) return;
    if (s) local.value = { ui: { ...s.ui }, notify: {} };
  }, { immediate: true });

  if (order === 'correct') {
    // 正确：先装回填，再 resetLocal / 装 dirty 监听
    registerFillWatch();
    resetLocal();
    registerDirtyWatch();
  } else {
    // 曾经的做法（有 bug）
    registerDirtyWatch();
    resetLocal();
    registerFillWatch();
  }

  return { dirty, local, settings };
}

describe('设置页表单装配顺序', () => {
  it('正确顺序：服务端设置到达后能回填，且 dirty 不会被 resetLocal 误置真', async () => {
    const { dirty, local, settings } = setupForm('correct');
    await nextTick();
    expect(dirty.value).toBe(false);

    settings.value = { ui: { site_title: '谛听', backup_schedule: 'daily' } };
    await nextTick();

    expect(local.value.ui.site_title).toBe('谛听');
    expect(local.value.ui.backup_schedule).toBe('daily');
  });

  it('正确顺序：用户编辑后 dirty=true，轮询到达的设置不再覆盖输入', async () => {
    const { dirty, local, settings } = setupForm('correct');
    await nextTick();
    settings.value = { ui: { site_title: '旧值' } };
    await nextTick();
    expect(local.value.ui.site_title).toBe('旧值');

    local.value = { ui: { site_title: '用户正在编辑' }, notify: {} };
    await nextTick();
    expect(dirty.value).toBe(true);

    // 模拟 10s 轮询推到新设置：不应覆盖用户输入
    settings.value = { ui: { site_title: '轮询新值' } };
    await nextTick();
    expect(local.value.ui.site_title).toBe('用户正在编辑');
  });

  it('错误顺序会复现 bug（回填被 dirty 拦截）——守住这个反例，避免改回去', async () => {
    const { dirty, local, settings } = setupForm('buggy');
    await nextTick();
    expect(dirty.value).toBe(true); // resetLocal 把 dirty 误置真

    settings.value = { ui: { site_title: '谛听' } };
    await nextTick();
    expect(local.value.ui.site_title).toBeUndefined(); // 回填被拦截
  });
});
