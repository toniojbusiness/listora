// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/',
      '**/.tsbuild/',
      '.local/',
      '.build/',
      'coverage/',
      'apps/ios/',
      // Generated from openapi.yaml by `npm run contract:generate`; checked for drift instead.
      'packages/api-contract/src/generated/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // Root config files are outside every workspace tsconfig; lint them with defaults.
        projectService: {
          allowDefaultProject: ['*.js', '*.ts'],
          defaultProject: 'tsconfig.base.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // Node runs .ts sources directly, so relative imports must name the real .ts file.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.{1,2}/.*\\.js$',
              message: 'Import the .ts source file; Node type stripping has no .js output.',
            },
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // Test doubles often return promises from non-async callbacks.
      '@typescript-eslint/require-await': 'off',
    },
  },
  prettier,
);
