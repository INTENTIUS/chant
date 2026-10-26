/**
 * The unit-test time budget (chant #2817): its value, and the message a test
 * over it fails with. `unit-test-budget.setup.ts` applies it to every test in
 * the `unit` vitest project.
 */

/**
 * The default budget: 5 seconds per unit test (#3793; 15 seconds before it).
 * In three CI runs every test left in the unit project took under 2s on a
 * loaded 4-core runner, but the next runs showed tests from that set at up to
 * 3.7s when a worker loaded a large module cold. 5s leaves 2.5x headroom over
 * the typical slowest time, while a test that runs the CLI, tsc or a build
 * over projects takes longer and belongs in the e2e project.
 */
export const DEFAULT_UNIT_TEST_BUDGET_MS = 5_000;

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

/**
 * The higher budget a named slow file gets (#4472): 15 seconds per test.
 */
export const SLOW_FILE_BUDGET_MS = 15_000;

/**
 * The unit-test files that drive real git repos, bare remotes and signing in
 * packages/core, which run 5 to 11s per test on a loaded 18-core Mac while
 * CI keeps them under 5s (#4472). Each gets {@link SLOW_FILE_BUDGET_MS}, so
 * they keep running on pull requests. Paths are repo-relative. The list is
 * the issue's file set spelled out, so a new file never joins it by a
 * pattern: make it fast, or add it here by name. Taking a file off the list
 * once it is fast again is the way out (#4472 option c).
 */
export const SLOW_UNIT_TEST_FILES: readonly string[] = [
  ...[
    "ci-green-branches",
    "ci-green-builds",
    "ci-green-cli",
    "ci-green-forge",
    "ci-green-runs",
    "ci-green-signed",
    "ci-green-workflow",
    "ci-green",
    "ci-serve-builds",
    "ci-serve-land",
    "ci-serve",
    "ci-run-index",
    "ci-run",
    "ci-runner-key",
    "ci-runner-start",
    "runs-statement",
    "runs",
    "lineage-adopt",
    "lineage-init-dir",
    "lineage-init",
    "lineage-lock",
    "lineage-migrations",
    "lineage-upgrade",
    "lineage-vendor",
    "status-contract",
    "status-decisions",
    "status-mixed",
    "status-revoked",
    "work-history",
    "check-contract",
    "graph-contract",
    "records-sessions-write",
  ].map((name) => `packages/core/src/workspace/${name}.test.ts`),
  ...[
    "release-at",
    "release-compose",
    "release-cut-signed",
    "release-cut",
    "release-flag",
    "release-join",
    "release-ledger",
    "release-publish",
    "release-verify",
    "release-workstation",
    "publish-resume",
    "work-lease",
  ].map((name) => `packages/core/src/lifecycle/${name}.test.ts`),
  ...["operator", "work-lease-run"].map((name) => `packages/core/src/op/${name}.test.ts`),
];

const slowFiles = new Set(SLOW_UNIT_TEST_FILES);

/**
 * The budget for a test in `file` (a repo-relative path, `/`-separated),
 * given the run's budget from {@link unitTestBudgetMs}. A named slow file
 * gets {@link SLOW_FILE_BUDGET_MS}, or the run's budget when that is higher;
 * 0 turns the budget off for every file. Every other file keeps the run's
 * budget.
 */
export function unitTestBudgetForFile(file: string | undefined, runBudgetMs: number): number {
  if (runBudgetMs === 0) return 0;
  if (file === undefined || !slowFiles.has(file.replaceAll("\\", "/"))) return runBudgetMs;
  return Math.max(SLOW_FILE_BUDGET_MS, runBudgetMs);
}

/**
 * The failure for a unit test that ran `elapsedMs` against a budget of
 * `budgetMs`. A test in a named slow file (#4472) has the message name the
 * file whose budget it went over.
 */
export function overBudgetMessage(name: string, elapsedMs: number, budgetMs: number, file?: string): string {
  const took = `"${name}" took ${(elapsedMs / 1000).toFixed(1)}s`;
  const slow = file !== undefined && slowFiles.has(file.replaceAll("\\", "/"));
  return [
    slow
      ? `${took}, over the ${budgetMs / 1000}s unit-test budget of its file, ${file} (chant #2817, #4472).`
      : `${took}, over the ${budgetMs / 1000}s unit-test budget (chant #2817).`,
    "Make it faster, or move it to a *.e2e.test.ts file: those are the e2e project (`just test-e2e`, and release-suites.yml on main before a release), which has no per-test budget and never runs on a pull request.",
    "CHANT_UNIT_TEST_BUDGET_MS changes the budget for a local run (0 turns it off).",
  ].join(" ");
}
