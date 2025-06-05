// 공식 마이그레이션 가이드: https://eslint.org/docs/latest/use/configure/migration-guide
import js from '@eslint/js';

/** @type {import('eslint').Linter.FlatConfig} */
export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly'
      }
    },
    rules: {}
  }
];
