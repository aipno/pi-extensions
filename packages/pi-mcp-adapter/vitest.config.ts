import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // CI (esp. Windows runners and the full 9-package matrix in parallel)
    // runs measurably slower than a dev machine; the 5s vitest default
    // caused load-related flakes in __tests__/commands-onboarding.test.ts.
    testTimeout: 15000,
    hookTimeout: 15000,
    env: {
      PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
      // Cache tests opt in explicitly to keep existing tests platform-neutral.
      PI_MCP_ADAPTER_DISABLE_AUTH_CACHE: "1",
    },
    include: ["__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["*.ts"],
      exclude: ["__tests__/**", "vitest.config.ts", "cli.js"],
    },
  },
});
