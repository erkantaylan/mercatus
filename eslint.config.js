// Flat config, shared by every package. G1: conventions are enforced by the linter with
// --max-warnings 0, not by review. Keep it short -- a rule here is a rule every agent meets.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/.next/**',
      // A second `next dev` instance gets its own distDir (NEXT_DIST_DIR), so the generated
      // output is `.next-pooled` / `.next-zenith` as well as `.next`.
      '**/.next-*/**',
      '**/coverage/**',
      '**/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // A type-only import that survives to runtime pulls a package into a bundle that did not
      // need it. verbatimModuleSyntax makes this load-bearing, not cosmetic.
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
);
