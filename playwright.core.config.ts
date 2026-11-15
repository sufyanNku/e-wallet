import { defineConfig } from "@playwright/test";
// Prevent Playwright's automatic AI error-page snapshot from recording a
// recovery screen. This switch is verified in the pinned runner source.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
export default defineConfig({
  testDir: "tests/browser-core",
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: "artifacts/phase-02/browser-results.json" }],
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
    url: "http://127.0.0.1:8787/api/v1/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
