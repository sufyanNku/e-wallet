import "./scripts/report-paths.ts";
import { defineConfig } from "@playwright/test";
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
export default defineConfig({
  testDir: "tests/browser-accounts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8877",
    headless: true,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
        "/opt/google/chrome/chrome",
      args: ["--no-sandbox"],
    },
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "pnpm exec tsx scripts/test-accounts-server.ts",
    url: "http://127.0.0.1:8877/api/v1/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
