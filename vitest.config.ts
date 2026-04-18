import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['src/__tests__/helpers/db.ts'],
    exclude: ['**/node_modules/**', '**/.git/**', '**/.claude/**'],
  },
})
