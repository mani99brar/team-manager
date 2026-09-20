import { defineConfig } from '@playwright/test'

const preview = process.env.MD_MANAGER_TEST_PREVIEW === '1'
const baseURL = `http://127.0.0.1:${process.env.MD_MANAGER_WEB_PORT ?? (preview ? 4173 : 5173)}`

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  // Browser tests mutate (and then clean) the shared fixture tree, so they must never run concurrently.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL,
    browserName: 'chromium',
    // Reduced motion makes the force layout settle synchronously, so nothing waits on animation.
    reducedMotion: 'reduce',
  },
  webServer: [
    {
      command: 'npm run start:api',
      url: `http://127.0.0.1:${process.env.MD_MANAGER_API_PORT ?? 3001}/api/entries`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: preview ? 'npm run preview' : 'npm run dev:web',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
