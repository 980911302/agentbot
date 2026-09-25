import { defineConfig } from '@playwright/test';

/**
 * 前端冒烟（OPT-05）：只跑窄流程，复用 test/fixtures/ui-preview.ts 的临时数据 + 假模型。
 * 不联网、不碰 .agentbot；命中真实 Chromium 的布局与键盘，补上 jsdom 测不到的那部分。
 *
 * 依赖与浏览器安装：
 *   npm i -D @playwright/test
 *   npx playwright install --only-shell chromium   # 只装 headless shell（约 195MB）
 */
const PORT = Number(process.env.AGENT_PREVIEW_PORT ?? 4599);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // 官方建议：CI 上串行，优先稳定与可复现（playwright.dev/docs/ci）
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'test-results/playwright',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    viewport: { width: 1280, height: 800 },
    // 失败留证据：截图 + trace（trace 只在失败时保留，不进仓库）
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx test/fixtures/ui-preview.ts',
    url: `http://127.0.0.1:${PORT}/`,
    env: { AGENT_PREVIEW_PORT: String(PORT) },
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
