// ESLint 9 flat config（前端）：js + TS + Vue 三套 recommended 叠加，同样不启 stylistic 规则。
// 类型检查交给 vue-tsc（npm run typecheck），这里只做 Lint 层把关。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';

export default [
  { ignores: ['dist/**', 'public/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  // 构建脚本（scripts/*.js）是 Node CommonJS，需要 node 全局与 CommonJS 变量
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  ...tseslint.configs.recommended,
  // 用 essential（只含错误预防）而非 recommended：后者带大量模板格式规则
  //（max-attributes-per-line 等 1200+ 条），与「不引入格式化 churn」的原则冲突。
  // 模板格式后续若要统一，交给 Prettier 单独决策，不塞进 ESLint。
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      // 与后端一致：空 catch 是本项目的既有降级手法
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  },
  {
    // vitest 全局 API（globals: true 模式下无需 import）
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        describe: 'readonly', it: 'readonly', expect: 'readonly', vi: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly', beforeAll: 'readonly', afterAll: 'readonly'
      }
    }
  }
];
