import { defineConfig } from "vitest/config";

// Unit tests: jsdom, no real Web Workers.
// Real Worker execution lives in vitest.browser.config.ts (`npm run test:browser`).
export default defineConfig({
  test: {
    name: "unit",
    globals: true,
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    exclude: ["test/browser/**", "test/node/**"],
  },
});
