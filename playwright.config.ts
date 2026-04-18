import { defineConfig, devices } from '@playwright/test'

// E2E 后端端口；避免与开发环境 3000 冲突
const BACKEND_PORT = 3001
// GitLab mock 端口
const MOCK_PORT = 4001

export default defineConfig({
  testDir: './src/__tests__/e2e',
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },

  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${BACKEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  outputDir: 'test-results/',

  globalSetup: './src/__tests__/e2e/helpers/global-setup.ts',
  globalTeardown: './src/__tests__/e2e/helpers/global-teardown.ts',

  // 两个 webServer 并行启动：GitLab mock、后端
  // 前端静态资源由后端 fastify-static 从 web/dist/ serve，需要用户先 cd web && pnpm build
  // reuseExistingServer: false — 本地端口复用会误判（4001/3001 探测假阳性），强制每次新启
  webServer: [
    {
      command: `./node_modules/.bin/tsx src/__tests__/e2e/mocks/gitlab-server.ts`,
      port: MOCK_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        MOCK_PORT: String(MOCK_PORT),
      },
    },
    {
      command: `./node_modules/.bin/tsx src/server.ts`,
      port: BACKEND_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        E2E_MODE: '1',
        CLAUDE_MOCK: '1',
        GITLAB_URL: `http://localhost:${MOCK_PORT}`,
        GITLAB_TOKEN: 'fake-token',
        PORT: String(BACKEND_PORT),
        DATABASE_URL: process.env.DATABASE_URL ?? '',
      },
    },
  ],
})
