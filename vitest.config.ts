import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each test file starts its own HTTP servers on ephemeral ports; keep files
    // isolated to avoid cross-talk.
    fileParallelism: false,
  },
});