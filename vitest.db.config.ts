import { defineConfig } from "vitest/config";

// Database tests: run against a local PostgreSQL prepared by tests/db/reset.sh.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
