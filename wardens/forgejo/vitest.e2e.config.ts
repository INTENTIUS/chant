import { defineConfig } from "vitest/config";

// Separate config for the gated, hermetic end-to-end suite (a Docker Compose
// Forgejo stack). Kept out of the default `npm test` run, which only globs
// `src/**`. Run with `npm run test:e2e:run`; the suite self-skips unless
// FORGEJO_E2E_URL / FORGEJO_E2E_TOKEN are set (see e2e/bootstrap.sh). A generous
// timeout absorbs real container/network latency.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 90_000,
  },
});
