import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Lint config deliberately scoped to catching bugs, not enforcing style — we don't want a
// mass reformat. Most TS-specific noise (explicit `any`, etc.) is relaxed; rules that catch
// real mistakes (unused vars, fallthrough, unsafe comparisons) stay on.
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.vsix', '**/*.json'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
);
