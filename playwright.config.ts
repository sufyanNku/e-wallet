import "./scripts/report-paths.ts";
import { defineConfig } from "@playwright/test";
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: ".local/reports/web/browser-results.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:8787",
    headless: true,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
        "/opt/google/chrome/chrome",
      args: ["--no-sandbox"],
    },
    screenshot: "off",
    trace: "off",
  },
  webServer: {
    command: "pnpm serve:web",
    env: { EWALLET_DATABASE_PATH: ".local/ui-browser/backend.sqlite" },
    url: "http://127.0.0.1:8787/api/v1/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
