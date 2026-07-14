import { defineConfig, devices } from "@playwright/test";

// E2E runs against a base URL. Default: a local `wrangler dev` (the real Worker +
// assets), which Playwright starts itself. For the post-deploy smoke check, pass
// BASE_URL=https://theskyisnotreal.com and only the @smoke (read-only) tests run.
const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const isLocal = BASE_URL.includes("localhost") || BASE_URL.includes("127.0.0.1");

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  // Local only: seed the D1 schema so the signup story can succeed.
  globalSetup: isLocal ? "./e2e/global-setup.js" : undefined,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Deterministic scans: reduced motion skips the animation and the 2% "REAL?!"
    // fake-out, so the verdict settles to FAKE immediately.
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: isLocal
    ? {
        command: "npm run dev",
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "ignore",
        stderr: "pipe",
      }
    : undefined,
});
