import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths({ ignoreConfigErrors: true })],
  test: {
    // Note: the top-level examples/ tree is not globbed wholesale — its
    // fargate docker e2e/volume suites need Docker and are not CI unit tests.
    // The shared example harness file is included explicitly.
    include: [
      "packages/**/*.test.ts",
      "lexicons/**/*.test.ts",
      "examples/examples.test.ts",
    ],
    environment: "node",
    // The Temporal runtime/compile-smoke suites bundle workflows with webpack
    // in-process, which loads the CI runner enough to push short-timeout tests
    // (e.g. build.test.ts discovery) past the 5s default under contention.
    // 20s absorbs that without masking a genuinely hung test for long.
    testTimeout: 20_000,
  },
});
