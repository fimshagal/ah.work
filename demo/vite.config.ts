import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone demo app. Resolves `ahwork` to the library source for live editing.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      ahwork: resolve(__dirname, "../src/index.ts"),
    },
  },
});
