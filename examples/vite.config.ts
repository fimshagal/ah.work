import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Multi-page React playground: Home / Examples / Demo / Tutorial / API.
// Each page is its own entry so the URLs stay plain and shareable.
// The library is imported from ../src for live editing.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        home: resolve(__dirname, "index.html"),
        examples: resolve(__dirname, "examples.html"),
        demo: resolve(__dirname, "demo.html"),
        tutorial: resolve(__dirname, "tutorial.html"),
        docs: resolve(__dirname, "docs.html"),
      },
    },
  },
});
