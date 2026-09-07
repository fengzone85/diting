import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // 覆盖率：只统计「单测有覆盖价值」的纯逻辑层（services / composables / utils）。
    // Vue 组件暂不纳入 —— 无 @vue/test-utils 基座（体检报告 #10），组件测试空白是已知项。
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/services/**', 'src/composables/**', 'src/utils/**'],
      // 纯文案字典与纯类型声明无单测价值，计入只会稀释指标
      exclude: ['src/utils/i18n/**', 'src/services/types.ts'],
      // 初始门禁 = 2026-09-07 基线（46.8% lines）下浮 5%，只防大幅回退。
      // 约定：后续 PR 只允许上调、不允许下调；补测试后应逐步抬升。
      thresholds: { lines: 42, functions: 42, branches: 75, statements: 42 }
    }
  },
});
