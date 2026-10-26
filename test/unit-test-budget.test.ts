import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_UNIT_TEST_BUDGET_MS,
  SLOW_FILE_BUDGET_MS,
  SLOW_UNIT_TEST_FILES,
  overBudgetMessage,
  unitTestBudgetForFile,
  unitTestBudgetMs,
} from "./unit-test-budget";

const repoRoot = resolve(import.meta.dirname, "..");

describe("the unit-test budget (chant #2817)", () => {
  test("is 5s unless CHANT_UNIT_TEST_BUDGET_MS says otherwise, and 0 turns it off", () => {
    expect(DEFAULT_UNIT_TEST_BUDGET_MS).toBe(5_000);
    expect(unitTestBudgetMs({})).toBe(5_000);
    expect(unitTestBudgetMs({ CHANT_UNIT_TEST_BUDGET_MS: "" })).toBe(5_000);
    expect(unitTestBudgetMs({ CHANT_UNIT_TEST_BUDGET_MS: "30000" })).toBe(30_000);
    expect(unitTestBudgetMs({ CHANT_UNIT_TEST_BUDGET_MS: "0" })).toBe(0);
  });

  test("refuses a value that is not a whole number of milliseconds", () => {
    expect(() => unitTestBudgetMs({ CHANT_UNIT_TEST_BUDGET_MS: "15s" })).toThrow(/whole number of milliseconds/);
  });

  test("the failure names the test, its time, the budget and where a slow test goes", () => {
    const message = overBudgetMessage("builds the world", 21_340, 5_000);
    expect(message).toContain('"builds the world" took 21.3s, over the 5s unit-test budget (chant #2817).');
    expect(message).toContain("*.e2e.test.ts");
    expect(message).toContain("just test-e2e");
  });
});

describe("the per-file budget for the named slow files (chant #4472)", () => {
  const slow = "packages/core/src/workspace/ci-green.test.ts";

  test("every listed file is a unit test in packages/core, listed once", () => {
    expect(SLOW_UNIT_TEST_FILES.length).toBeGreaterThan(0);
    expect(new Set(SLOW_UNIT_TEST_FILES).size).toBe(SLOW_UNIT_TEST_FILES.length);
    for (const file of SLOW_UNIT_TEST_FILES) {
      expect(file).toMatch(/^packages\/core\/src\/(workspace|lifecycle|op)\/[a-z-]+\.test\.ts$/);
      expect(existsSync(join(repoRoot, file)), file).toBe(true);
    }
  });

  test("a listed file gets its higher budget and every other file keeps 5s", () => {
    expect(SLOW_FILE_BUDGET_MS).toBe(15_000);
    for (const file of SLOW_UNIT_TEST_FILES) expect(unitTestBudgetForFile(file, DEFAULT_UNIT_TEST_BUDGET_MS)).toBe(15_000);
    expect(unitTestBudgetForFile("packages/core/src/workspace/ci-green.e2e.test.ts", DEFAULT_UNIT_TEST_BUDGET_MS)).toBe(5_000);
    expect(unitTestBudgetForFile("packages/core/src/workspace/projects.test.ts", DEFAULT_UNIT_TEST_BUDGET_MS)).toBe(5_000);
    expect(unitTestBudgetForFile("test/unit-test-budget.test.ts", DEFAULT_UNIT_TEST_BUDGET_MS)).toBe(5_000);
    expect(unitTestBudgetForFile(undefined, DEFAULT_UNIT_TEST_BUDGET_MS)).toBe(5_000);
    expect(unitTestBudgetForFile(slow.replaceAll("/", "\\"), DEFAULT_UNIT_TEST_BUDGET_MS)).toBe(15_000);
  });

  test("CHANT_UNIT_TEST_BUDGET_MS raises a listed file's budget only above 15s, and 0 turns every budget off", () => {
    expect(unitTestBudgetForFile(slow, 30_000)).toBe(30_000);
    expect(unitTestBudgetForFile(slow, 1_000)).toBe(15_000);
    expect(unitTestBudgetForFile("test/unit-test-budget.test.ts", 1_000)).toBe(1_000);
    expect(unitTestBudgetForFile(slow, 0)).toBe(0);
    expect(unitTestBudgetForFile("test/unit-test-budget.test.ts", 0)).toBe(0);
  });

  test("the failure in a listed file names the file and its budget", () => {
    const message = overBudgetMessage("signs the release", 16_200, 15_000, slow);
    expect(message).toContain(`"signs the release" took 16.2s, over the 15s unit-test budget of its file, ${slow} (chant #2817, #4472).`);
    expect(overBudgetMessage("quick", 6_000, 5_000, "test/unit-test-budget.test.ts")).toContain("over the 5s unit-test budget (chant #2817).");
  });
});
