import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 1 : undefined,
  reporter: CI ? 'list' : [['list'], ['html', { open: 'never' }]],

  /*
   * Longer than Playwright's 5s default, because these assertions wait on a
   * round trip through a real stack — REST to Neon, or a CRDT sync over the
   * collab socket — and a full parallel run puts six workers on one dev
   * server. At 5s that was fine alone and flaky together, and the suite had
   * been answering one assertion at a time with an explicit timeout (#28).
   * The wait is an upper bound, not a delay: a passing assertion still
   * resolves as soon as the value arrives, so this costs nothing when the
   * stack keeps up. The test timeout rises with it to stay clear of specs
   * that make several such waits in a row.
   */
  expect: { timeout: 15_000 },
  timeout: 60_000,

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
      // REST and the collaboration socket now share this one server.
      command: 'pnpm -F @xdocs/api dev',
      url: 'http://localhost:3001/health',
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
