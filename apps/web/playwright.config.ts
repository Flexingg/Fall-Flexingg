import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against the demo API (apps/api: `pnpm demo`) and the built web app.
 * CI starts both; locally: `pnpm --filter @gauntlet/api demo` then `pnpm e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4173',
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'pnpm vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true },
});
