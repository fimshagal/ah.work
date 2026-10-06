import { defineConfig } from "vitest/config";

// Runs inside a real Chromium via Playwright, so `new Worker(blob:)` works.
// That is the difference vs the default `npm test` suite (jsdom + fake workers).
export default defineConfig({
  test: {
    name: "browser",
    include: ["test/browser/**/*.test.ts"],
    browser: {
      enabled: true,
      name: "chromium",
      provider: "playwright",
      headless: true,
    },
  },
});
