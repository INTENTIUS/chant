/**
 * The unit-test time budget (chant #2817): its value, and the message a test
 * over it fails with. `unit-test-budget.setup.ts` applies it to every test in
 * the `unit` vitest project.
 */

/** The default budget: 15 seconds per unit test. */
export const DEFAULT_UNIT_TEST_BUDGET_MS = 15_000;

/**
 * The budget in milliseconds. `CHANT_UNIT_TEST_BUDGET_MS` overrides the
 * default, and 0 turns the budget off (for a debugger, say). A value that is
 * not a whole number of milliseconds is refused rather than ignored.
 */
export function unitTestBudgetMs(env: Record<string, string | undefined>): number {
  const raw = env.CHANT_UNIT_TEST_BUDGET_MS;
  if (raw === undefined || raw === "") return DEFAULT_UNIT_TEST_BUDGET_MS;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`CHANT_UNIT_TEST_BUDGET_MS must be a whole number of milliseconds, or 0 to turn the budget off; got "${raw}".`);
  }
  return Number(raw);
}

/** The failure for a unit test that ran `elapsedMs` against a budget of `budgetMs`. */
export function overBudgetMessage(name: string, elapsedMs: number, budgetMs: number): string {
  return [
    `"${name}" took ${(elapsedMs / 1000).toFixed(1)}s, over the ${budgetMs / 1000}s unit-test budget (chant #2817).`,
    "Make it faster, or move it to a *.e2e.test.ts file: CI runs those in the test-e2e job, which has no per-test budget.",
    "CHANT_UNIT_TEST_BUDGET_MS changes the budget for a local run (0 turns it off).",
  ].join(" ");
}
