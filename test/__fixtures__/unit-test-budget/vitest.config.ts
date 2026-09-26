import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * A run of the unit budget's own setup file over two tests, for
 * test/unit-test-budget.e2e.test.ts (chant #2817). The spawning test sets
 * CHANT_UNIT_TEST_BUDGET_MS low so the slow test goes over it quickly.
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["budget.test.ts"],
    setupFiles: [fileURLToPath(new URL("../../unit-test-budget.setup.ts", import.meta.url))],
    globalSetup: [],
  },
});
