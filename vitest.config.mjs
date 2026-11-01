import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    globalSetup: ["./test/global-setup.mjs"],
    // one real n8n and one set of shared mocks: test files run one after another
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 240_000,
    teardownTimeout: 60_000,
    reporters: ["default"],
  },
});
