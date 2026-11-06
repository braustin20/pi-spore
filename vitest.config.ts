import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against workspace sources, not built dist output.
    conditions: ["@pi-spore/source"],
  },
  ssr: {
    resolve: { conditions: ["@pi-spore/source"] },
  },
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "modules/*/**/*.test.{ts,tsx}"],
  },
});
