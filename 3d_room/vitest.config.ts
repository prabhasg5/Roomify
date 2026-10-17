import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is the old example/ app.
export default defineConfig({
  test: { include: ["app/**/*.test.ts"] },
});
