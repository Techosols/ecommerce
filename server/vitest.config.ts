import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/env.ts'],
    // Integration tests share one Postgres database; run files serially so that
    // schema-level operations (migrations, truncation) cannot interleave.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/main/**', 'src/**/*.d.ts'],
    },
  },
})
