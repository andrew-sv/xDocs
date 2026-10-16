// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'apps/web/playwright-report/**',
      'apps/web/test-results/**',
      'apps/api/drizzle/**',
    ],
  },

  js.configs.recommended,

  // TypeScript, type-aware: the promise rules need types to see a Promise.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // In no tsconfig: apps/web's carries only browser types.
          allowDefaultProject: ['apps/web/playwright.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /*
       * The API is one long-lived process: an unawaited rejection is an
       * unhandled rejection. Deliberate fire-and-forget says so with `void`,
       * as `identityFromApiKey` already does.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      // An async onClick is fine — React ignores the return value.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      /*
       * Off because the libraries at our edges are typed `any`, not because
       * our code is: Yjs declares `toDelta()` as any and omits the
       * `toString()` that Y.Text has at runtime, and Vite types every
       * `import.meta.env` value as any. Enforcing these would mean a cast at
       * every Yjs read, which hides more than it checks.
       */
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  /*
   * React hooks. The dependency arrays carry real invariants here — CLAUDE.md
   * on not adding `me` to the block editor's deps — so a deliberate omission
   * should be a visible, commented disable rather than silent.
   */
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Plain-Node scripts and test suites: no type information, Node globals.
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
