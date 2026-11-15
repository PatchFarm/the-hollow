import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/fixtures/**"],
    // Many tests start real processes (git, sh, the fake actionlint). With every file running in
    // parallel on a busy machine, they can take longer than vitest's 5 second default.
    testTimeout: 20_000,
  },
});
