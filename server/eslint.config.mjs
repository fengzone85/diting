// ESLint 9 flat config（后端）：只约束「正确性 / 潜在 bug」，不启用 stylistic 类规则。
// 现有代码风格已事实统一（2 空格、单引号），引入 Prettier 只会产生覆盖全仓的巨型 diff。
import js from '@eslint/js';
import globals from 'globals';

export default [
  // 注意：public.bak-*/ 与 themes/ 里是被 gitignore 的旧版前端产物（含 document/localStorage 等
  // 浏览器全局），不是后端代码，必须排除，否则会产生数百个 no-undef 假阳性。
  { ignores: ['web/**', 'public/**', 'public.bak-*/**', 'themes/**', 'node_modules/**', 'data/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      // Express 错误中间件必须有第 4 个参数（next）才会被识别为错误处理器，故放行为未使用变量。
      'no-unused-vars': ['warn', { argsIgnorePattern: '^(next|_)' }],
      'no-console': 'off',            // 本项目日志以 console 输出为既有风格
      // 本项目刻意大量使用空 catch 做「失败即降级」（如 parsing 失败回退），故放行空 catch；
      // 其余空块（if/for/try 的空语句）仍告警。
      'no-empty': ['warn', { allowEmptyCatch: true }],
      eqeqeq: ['warn', 'smart']
    }
  },
  {
    // node --test 会注入全局 describe/it/test 等，这里补声明避免 no-undef 误报
    files: ['test/**/*.js', '**/*.test.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        describe: 'readonly', it: 'readonly', test: 'readonly',
        before: 'readonly', after: 'readonly', beforeEach: 'readonly', afterEach: 'readonly'
      }
    }
  }
];
