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
      // 纯文案字典与纯类型声明无单测价值，计入只会稀释指标；
      // *.test.ts 与源码同目录时 vitest 默认 exclude（只排 test/ 目录名）不会排除它们，
      // 测试文件自身（天然 ~100% 覆盖）会把总分灌高——曾致报告 56.87% 而真实业务覆盖仅 40.58%，
      // 门禁形同虚设，必须显式排除。
      exclude: ['src/utils/i18n/**', 'src/services/types.ts', 'src/**/*.test.ts'],
      // 初始门禁 = 2026-09-07 排除测试文件后的真实基线（lines 40.58%）下浮 5%。
      // 约定：后续 PR 只允许上调、不允许下调；补测试后应逐步抬升。
      // 2026-10-20 上调（S2-F5 补 adminApi 契约测试后实测 lines 58.3 / functions 76.42 /
      // branches 81.69，按「实测下浮」留出小幅波动空间）：lines/statements 35→55、
      // functions 35→70、branches 70→78。此前的 35% 函数门禁曾因 adminApi 方法增多被击穿。
      thresholds: { lines: 55, functions: 70, branches: 78, statements: 55 }
    }
  },
});
