import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * chant #2817 acceptance: a unit test over the budget fails the run, and the
 * failure names the budget. This runs vitest itself over a fixture that loads
 * the unit project's setup file, with the budget lowered to 500ms so a 1.5s
 * test goes over it.
 */
const repoRoot = resolve(import.meta.dirname, "..");
const fixture = join(repoRoot, "test", "__fixtures__", "unit-test-budget");

describe("the unit-test budget, in a real vitest run", () => {
  test("a test over the budget fails, the message names the budget, and a quick test still passes", () => {
    const run = spawnSync(process.execPath, [join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", "--config", join(fixture, "vitest.config.ts")], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, CHANT_UNIT_TEST_BUDGET_MS: "500", NO_COLOR: "1", CI: "1" },
      timeout: 120_000,
    });
    const out = `${run.stdout}\n${run.stderr}`;
    expect(run.status, out).toBe(1);
    expect(out).toMatch(/"a slow test goes over the budget" took \d+\.\ds, over the 0\.5s unit-test budget \(chant #2817\)/);
    expect(out).toMatch(/1 failed \| 1 passed/);
  }, 120_000);
});
