import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@dev-learning-ai/core": src("./packages/core/src/index.ts"),
      "@dev-learning-ai/runtime": src("./packages/runtime/src/index.ts"),
      "@dev-learning-ai/dashboard": src("./packages/dashboard/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "examples/*/test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 30000,
    pool: "forks",
  },
});
