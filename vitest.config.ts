import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 90,
        functions: 75, // 7/9 — remaining two are anonymous catch lambdas for defensive "never happens in prod" paths
        branches: 85,
        statements: 90,
      },
    },
  },
})
