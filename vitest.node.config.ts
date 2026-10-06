import { defineConfig } from "vitest/config";

// Runs on real `node:worker_threads`, so no DOM and no blob URLs are involved.
// The mirror image of vitest.browser.config.ts: same library, other backend.
export default defineConfig({
  test: {
    name: "node",
    globals: true,
    environment: "node",
    include: ["test/node/**/*.test.ts"],
    // Worker threads are the point here; running files in parallel would make
    // the pool-size assertions race for the same CPU.
    fileParallelism: false,
  },
});
