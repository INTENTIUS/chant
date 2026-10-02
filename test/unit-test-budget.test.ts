import { describe, expect, test } from "vitest";
import { DEFAULT_UNIT_TEST_BUDGET_MS, overBudgetMessage, unitTestBudgetMs } from "./unit-test-budget";

describe("the unit-test budget (chant #2817)", () => {
  test("is 15s unless CHANT_UNIT_TEST_BUDGET_MS says otherwise, and 0 turns it off", () => {
    expect(DEFAULT_UNIT_TEST_BUDGET_MS).toBe(15_000);
    expect(unitTestBudgetMs({})).toBe(15_000);
    expect(unitTestBudgetMs({ CHANT_UNIT_TEST_BUDGET_MS: "" })).toBe(15_000);
    expect(unitTestBudgetMs({ CHANT_UNIT_TEST_BUDGET_MS: "30000" })).toBe(30_000);
    expect(unitTestBudgetMs({ CHANT_UNIT_TEST_BUDGET_MS: "0" })).toBe(0);
  });

  test("refuses a value that is not a whole number of milliseconds", () => {
    expect(() => unitTestBudgetMs({ CHANT_UNIT_TEST_BUDGET_MS: "15s" })).toThrow(/whole number of milliseconds/);
  });

  test("the failure names the test, its time, the budget and where a slow test goes", () => {
    const message = overBudgetMessage("builds the world", 21_340, 15_000);
    expect(message).toContain('"builds the world" took 21.3s, over the 15s unit-test budget (chant #2817).');
    expect(message).toContain("*.e2e.test.ts");
    expect(message).toContain("test-e2e job");
  });
});
