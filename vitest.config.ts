import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
    include: [
      "apps/desktop/src/main/**/*.test.ts",
      "apps/desktop/src/shared/**/*.test.ts",
      "packages/**/*.test.ts",
      "tools/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
  },
});
