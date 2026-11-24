import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    baseURL: process.env.E2E_WEB_URL ?? "http://localhost:3000",
    channel: process.env.E2E_BROWSER_CHANNEL ?? "chromium",
    launchOptions:
      process.env.E2E_IPV4 === "1"
        ? { args: ["--host-resolver-rules=MAP localhost 127.0.0.1"] }
        : undefined,
    trace: "off",
    screenshot: "off",
  },
  projects: [
    { name: "chromium", use: { viewport: { width: 1440, height: 900 } } },
  ],
});
