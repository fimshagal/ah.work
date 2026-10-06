import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

// Library build for AhWork. Produces tree-shakeable ESM + type declarations.
export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    lib: {
      // Two entries, one per worker backend. Consumers never pick by hand:
      // package.json `exports` routes Node to the worker_threads build and
      // everything else to the Web Worker one.
      entry: {
        ahwork: resolve(__dirname, "src/index.ts"),
        "ahwork.node": resolve(__dirname, "src/index.node.ts"),
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      // Keep the bundle dependency-free. `node:worker_threads` is a built-in
      // and must stay external; it only ever loads in the Node entry.
      external: [/^node:/],
    },
  },
  plugins: [
    dts({
      // One rolled-up .d.ts per entry, so the Node build can advertise the
      // extra `nodeWorkerPrelude` export without leaking it into the web one.
      rollupTypes: true,
      include: ["src"],
    }),
  ],
});
