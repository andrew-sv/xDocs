import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 1 : undefined,
  reporter: CI ? 'list' : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:5173',
    // Traces are how a failure gets diagnosed when nobody is watching the
    // browser — worth the overhead here.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /*
   * Three servers, each with its own readiness probe. Started separately rather
   * than via `pnpm dev` so Playwright can wait on each one individually;
   * reuseExistingServer picks up a `pnpm dev` that is already running locally.
   */
  webServer: [
    {
      command: 'pnpm -F @xdocs/api dev',
      url: 'http://localhost:3001/health',
      reuseExistingServer: !CI,
      timeout: 60_000,
      cwd: '../..',
    },
    {
      command: 'pnpm -F @xdocs/api dev:collab',
      // Hocuspocus serves plain HTTP on the same port as the websocket.
      url: 'http://localhost:1234',
      reuseExistingServer: !CI,
      timeout: 60_000,
      cwd: '../..',
    },
    {
      command: 'pnpm -F @xdocs/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !CI,
      timeout: 60_000,
      cwd: '../..',
    },
  ],
});
