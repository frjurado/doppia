import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // All /api/* requests are proxied to FastAPI in development.
      // This means the browser sees one origin (localhost:5173), so CORS never
      // triggers locally. CORS middleware in FastAPI handles staging/production.
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // Vitest owns the unit tests under src/. The Playwright e2e specs live in
    // e2e/ and run via `npm run e2e` — scope the include so vitest's default
    // `**/*.spec.ts` glob doesn't try to execute them (they import
    // @playwright/test, which errors under the vitest runner).
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
