import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5199', trace: 'retain-on-failure' },
  webServer: { command: 'node test/e2e/serve.mjs', url: 'http://localhost:5199/test/e2e/fixture/index.html', reuseExistingServer: true },
});
