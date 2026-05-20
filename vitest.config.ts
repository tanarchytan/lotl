import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/vault/**"],
      exclude: ["assets/vault-viewer/**", "test/**", "**/*.d.ts"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
