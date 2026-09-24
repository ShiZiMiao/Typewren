import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: {
    timeout: 10000
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    // retries=0 下 on-first-retry 永不采集，失败现场无 trace 可查
    trace: 'retain-on-failure'
  }
});
