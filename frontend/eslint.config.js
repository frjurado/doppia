import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import i18next from 'eslint-plugin-i18next';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
      i18next,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // CONTRIBUTING.md: no unexcused `any` — warn rather than error so developers
      // can add `any` with an explanatory comment when genuinely necessary.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Accessibility: headings must have content and must not skip levels.
      'jsx-a11y/heading-has-content': 'error',
      // i18n guard (Component 9 Step 25): no hardcoded user-facing text in JSX.
      // Scoped to JSX text content (the highest-value, lowest-noise target);
      // translatable attributes (placeholder/aria-label/title) were extracted in
      // the same step but are not machine-enforced here to avoid false positives
      // on structural attributes (className, role, `as`, route paths, etc.).
      // Symbol/number-only text and a short brand/notation allowlist are permitted.
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-text-only',
          words: {
            exclude: ['^[^A-Za-z]+$', '^(Doppia|Verovio|Bravura|DCML)$'],
          },
        },
      ],
    },
  },
  {
    // The i18n guard targets product UI only; tests and the i18n module itself
    // legitimately contain English string literals.
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**', 'src/i18n/**'],
    rules: {
      'i18next/no-literal-string': 'off',
    },
  }
);
