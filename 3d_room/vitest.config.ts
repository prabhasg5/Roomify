import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is example/ (the page + run-time assets).
export default defineConfig({
  test: { include: ["app/**/*.test.ts"] },
});
