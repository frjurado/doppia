import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e config (Component 10 Step 14) — the first browser-level
 * coverage, scoped to the anonymous public read journey.
 *
 * The suite runs against a `vite preview` of the production build (so it
 * exercises the real bundle + real Verovio WASM), with the backend API stubbed
 * per-test via `page.route` (see e2e/public-read.spec.ts) — no live backend,
 * database, or seeded data is required, so it is fast and green in CI headless.
 * Editor/authoring flows get e2e coverage when their components stabilise
 * (Component 12+); this scaffold stays deliberately minimal.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    // Pin the locale so i18n accessible names (Play, Edit, …) are deterministic.
    locale: 'en-US',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Serves the built SPA. CI runs `npm run build` in a prior step; locally,
    // build once then `npx playwright test`. --strictPort so the URL is stable.
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
