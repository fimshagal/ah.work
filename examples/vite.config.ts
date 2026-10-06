import { resolve } from "node:path";
import { defineConfig } from "vite";

// Multi-page playground: Home / Examples / Tutorial / API.
// Library is imported from ../src for live editing.
export default defineConfig({
  root: __dirname,
  build: {
    rollupOptions: {
      input: {
        home: resolve(__dirname, "index.html"),
        examples: resolve(__dirname, "examples.html"),
        tutorial: resolve(__dirname, "tutorial.html"),
        docs: resolve(__dirname, "docs.html"),
      },
    },
  },
});
