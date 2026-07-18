import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
const command = `bun run dev -- --host 0.0.0.0 --port ${port}`
const reuse = !process.env.CI
const workers = Number(process.env.PLAYWRIGHT_WORKERS ?? (process.env.CI ? 5 : 0)) || undefined
const reportFolder = process.env.PLAYWRIGHT_HTML_OUTPUT_DIR ?? "e2e/playwright-report"

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: process.env.PLAYWRIGHT_FULLY_PARALLEL === "1",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter: [
    ["html", { outputFolder: reportFolder, open: "never" }],
    ["line"],
    ...(process.env.PLAYWRIGHT_JUNIT_OUTPUT
      ? [["junit", { outputFile: process.env.PLAYWRIGHT_JUNIT_OUTPUT }] as const]
      : []),
  ],
  webServer: {
    command,
    url: baseURL,
    reuseExistingServer: reuse,
    timeout: 120_000,
    env: {
      VITE_OC2_SERVER_HOST: serverHost,
      VITE_OC2_SERVER_PORT: serverPort,
      VITE_OC2_TEAM_BOARD: process.env.VITE_OC2_TEAM_BOARD ?? "",
    },
  },
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      testMatch: "**/smoke/mobile-shell.spec.ts",
      use: { ...devices["Pixel 5"] },
    },
  ],
})
