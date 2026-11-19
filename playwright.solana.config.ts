import "./scripts/report-paths.ts";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser-solana",
  workers: 1,
  reporter: [
    ["list"],
    [
      "json",
      { outputFile: ".local/reports/chains/solana-browser-results.json" },
    ],
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
    video: "off",
  },
  webServer: {
    command: "pnpm serve:web",
    env: { EWALLET_ISOLATED_SOLANA_TEST: "1", PLAYWRIGHT_NO_COPY_PROMPT: "1" },
    url: "http://127.0.0.1:8787/api/v1/health",
    reuseExistingServer: false,
  },
});
