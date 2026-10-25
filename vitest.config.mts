import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// .mts keeps the test runner's config loader in ESM mode.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
