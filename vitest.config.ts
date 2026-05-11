import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // globalSetup：本地启 testcontainers postgres，CI 短路（见文件头注释）
    globalSetup: ['src/__tests__/setup/pg-container.ts'],
    setupFiles: ['src/__tests__/helpers/db.ts'],
    // integration/ 下仍有 PG 依赖测试共享单 schema，并发跑会 DROP SCHEMA 竞态。串行保险。
    fileParallelism: false,
    exclude: ['**/node_modules/**', '**/.git/**', '**/.claude/**', '**/mock-e2e/**', '**/var/**'],
  },
})
