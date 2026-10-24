'use strict';

/**
 * Flat config. The codebase is already consistent and lint-clean; this exists
 * to keep it that way and to catch the bug-shaped mistakes (unused vars,
 * accidental globals, unreachable code) that no test would.
 *
 * Formatting is Prettier's job, not ESLint's -- eslint-config-prettier turns
 * off every stylistic rule that would fight it.
 */

const globals = require('globals');
const prettier = require('eslint-config-prettier');

const nodeRules = {
  files: ['**/*.js'],
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'commonjs',
    globals: { ...globals.node },
  },
  linterOptions: {
    reportUnusedDisableDirectives: true,
  },
  rules: {
    'no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
    ],
    'no-undef': 'error',
    'no-var': 'error',
    'prefer-const': 'error',
    eqeqeq: ['error', 'smart'],
    'no-throw-literal': 'error',
    'no-return-await': 'error',
    'no-console': 'off',
  },
};

module.exports = [
  { ignores: ['node_modules/', 'dist/', 'vendor/', 'models/', 'build/', 'site/', 'src-tauri/'] },
  nodeRules,
  {
    // The window's scripts run in a browser, not Node.
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
  prettier,
];
