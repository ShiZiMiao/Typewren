import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'dist/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      '*.tsbuildinfo'
    ]
  },
  ...tseslint.configs.recommended,
  // 关闭与 Prettier 冲突的格式类规则（排版交给 Prettier）
  prettier,
  {
    rules: {
      // 项目内已无显式 any（个别来自库类型的透传），保留告警而非阻断
      '@typescript-eslint/no-explicit-any': 'warn',
      // 回调/协议固定的未用参数用 _ 前缀表达（与该约定下 Prettier/TS 一致）
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  }
);
