import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

const TS_FILES = ['**/*.{ts,tsx}'];
const JS_FILES = ['**/*.{js,mjs,cjs}'];
const UNUSED_VARS = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrors: 'none',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-verify/**',
      '**/target/**',
      '**/runtimes/**',
      '**/.tmp/**',
      '**/generated/**',
      '**/gen/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: TS_FILES })),
  {
    files: TS_FILES,
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', UNUSED_VARS],
      '@typescript-eslint/no-explicit-any': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  {
    files: JS_FILES,
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', UNUSED_VARS],
    },
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      'no-sparse-arrays': 'warn',
    },
  },
  prettier,
];
