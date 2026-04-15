import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['src/__tests__/helpers/db.ts'],
    // Tests share a single Postgres schema; running files concurrently
    // causes DROP SCHEMA races. Run files serially.
    fileParallelism: false,
  },
})
