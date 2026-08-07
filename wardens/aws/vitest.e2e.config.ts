import { defineConfig } from "vitest/config";

// Separate config for the gated end-to-end suite against a floci (AWS
// emulator) endpoint. Kept out of the default `npm test` run, which only
// globs `src/**`. Run with `npm run test:e2e`; the suite self-skips unless
// AWS_ENDPOINT_URL is set (see e2e/bootstrap.sh). A generous timeout absorbs
// real container/network latency.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 90_000,
  },
});
