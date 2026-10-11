/**
 * The unit-test time budget (chant #2817): its value, and the message a test
 * over it fails with. `unit-test-budget.setup.ts` applies it to every test in
 * the `unit` vitest project.
 */

/**
 * The default budget: 3 seconds per unit test (#3793; 15 seconds before it).
 * In three CI runs every test left in the unit project took under 2s on a
 * loaded 4-core runner, so 3s leaves 1.5x headroom for runner variance, while
 * a test that runs the CLI, tsc or a build over projects takes longer and
 * belongs in the e2e project.
 */
export const DEFAULT_UNIT_TEST_BUDGET_MS = 3_000;

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
    "Make it faster, or move it to a *.e2e.test.ts file: those are the e2e project (`just test-e2e`, and release-suites.yml on main before a release), which has no per-test budget and never runs on a pull request.",
    "CHANT_UNIT_TEST_BUDGET_MS changes the budget for a local run (0 turns it off).",
  ].join(" ");
}
