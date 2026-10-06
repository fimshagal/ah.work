import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

// Library build for AhWork. Produces tree-shakeable ESM + type declarations.
export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "AhWork",
      formats: ["es"],
      fileName: () => "ahwork.js",
    },
    rollupOptions: {
      // Keep the bundle dependency-free; nothing external is expected for the MVP.
      external: [],
    },
  },
  plugins: [
    dts({
      rollupTypes: true,
      include: ["src"],
    }),
  ],
});
