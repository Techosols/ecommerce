import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files live outside tsconfig's include; type-aware linting
          // still needs a program for them.
          allowDefaultProject: ['eslint.config.js', '.prettierrc.json'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'smart'],
      'no-restricted-syntax': [
        'error',
        {
          // §16.8 — only config/env.ts may read process.env.
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message: 'Read configuration from src/config/env.ts, never process.env directly.',
        },
        {
          // §16.3 — SQL is parameterised; never built by concatenation/interpolation.
          selector: 'TaggedTemplateExpression[tag.name=/^(sql|SQL)$/]',
          message: 'Use parameterised queries via the query() helper, not tagged SQL templates.',
        },
      ],
    },
  },

  // Architectural boundaries (§1.2, §2.2).
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/features/*/*', '!**/features/*/index.js'],
              message:
                'Import another feature only through its public index.ts (§2.2 public-surface rule).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/features/**'],
              message: 'infrastructure/ must not depend on features/ (§1.2 dependency direction).',
            },
            {
              group: ['**/features/*/*', '!**/features/*/index.js'],
              message: 'Import another feature only through its public index.ts.',
            },
          ],
        },
      ],
    },
  },

  // router.ts is the composition root: mounting a feature's routes is exactly
  // its job, so it is the one file allowed to reach past a feature's index.ts.
  {
    files: ['src/router.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // The one sanctioned reader of process.env.
  {
    files: ['src/config/env.ts', 'scripts/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // The migration CLI is a console program by definition.
    files: ['src/infrastructure/database/migrate/cli.ts'],
    rules: { 'no-console': 'off' },
  },
)
