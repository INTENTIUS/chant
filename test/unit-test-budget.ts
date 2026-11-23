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
 *
 * The budget is for an unloaded machine. When the one-minute load average is
 * above the core count, the budget a test gets grows by that ratio
 * ({@link loadFactor}, #5221), so a test fails for being slow itself and not
 * for sharing the machine with a full suite or other jobs.
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
 * How much a test's budget grows on a loaded machine (#5221): the one-minute
 * load average over the core count, and never below 1. At or under one
 * runnable process per core nothing changes; at load 45 on 18 cores the
 * factor is 2.5, so 5s becomes 12.5s.
 */
export function loadFactor(loadavg: number, cpus: number): number {
  if (!Number.isFinite(loadavg) || !Number.isFinite(cpus) || cpus <= 0) return 1;
  return Math.max(1, loadavg / cpus);
}

/** The load a budget was scaled for: the one-minute load average and the core count. */
export interface BudgetLoad {
  loadavg: number;
  cpus: number;
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
    // #4502: walks real git history per test and is load-sensitive, 5.4 to 16.9s
    // alone on a loaded Mac (slowest test 1.8 to 5.9s).
    "intent-gaps",
    // #5136: cuts and publishes a train of real member releases in a temp repo, through the fake npm,
    // as publish-resume does; 2 to 5.5s per test on a loaded Mac.
    "train-publish",
  ].map((name) => `packages/core/src/workspace/${name}.test.ts`),
  ...[
    "release-at",
    "release-compose",
    "release-cut-signed",
    "release-cut",
    "release-flag",
    // #5177: cuts, signs, rewrites the cut line and verifies again in a temp repo, as release-verify does.
    "release-gate-seal",
    "release-join",
    "release-ledger",
    "release-publish",
    "release-verify",
    "release-workstation",
    "publish-resume",
    // #5163: cuts two releases in a temp repo and changes their status through the fake npm, registry, forge and tap.
    "release-status-change",
    "work-lease",
    // The ruling for ci-products (2026-10-28): two and three clones of a bare remote take, queue for and release
    // rows, each read a git fetch; 2.7 to 5.6s per test alone on a loaded Mac.
    "resource-lock-wait",
  ].map((name) => `packages/core/src/lifecycle/${name}.test.ts`),
  // The same, through a whole wave job on a bare remote (op-waves-ledger-lock), 1.1 to 6.2s per test alone on a loaded Mac.
  ...["operator", "work-lease-run", "op-waves-ledger-lock"].map((name) => `packages/core/src/op/${name}.test.ts`),
  // #5557: generates the whole graph schema from the TypeScript types in one test, 5.4s on a CI runner; that one
  // failure on main revoked a green commit, which no release can then be cut from.
  "packages/core/src/graph-schema/graph-schema.test.ts",
  // #5521: each test runs a promote through a stage's op waves in a temp repo, 5.0 to 5.4s on a CI shard and on a
  // loaded Mac.
  "packages/core/src/cli/handlers/promote-stage-waves.test.ts",
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
 * file whose budget it went over. With `load` (#5221) and a factor above 1,
 * the message gives the budget the test had after scaling for the load.
 */
export function overBudgetMessage(name: string, elapsedMs: number, budgetMs: number, file?: string, load?: BudgetLoad): string {
  const took = `"${name}" took ${(elapsedMs / 1000).toFixed(1)}s`;
  const slow = file !== undefined && slowFiles.has(file.replaceAll("\\", "/"));
  const factor = load === undefined ? 1 : loadFactor(load.loadavg, load.cpus);
  const scaled =
    load !== undefined && factor > 1
      ? `, scaled to ${+(budgetMs * factor / 1000).toFixed(1)}s for load ${+load.loadavg.toFixed(1)} on ${load.cpus} cores`
      : "";
  return [
    slow
      ? `${took}, over the ${budgetMs / 1000}s unit-test budget of its file, ${file}${scaled} (chant #2817, #4472).`
      : `${took}, over the ${budgetMs / 1000}s unit-test budget${scaled} (chant #2817).`,
    "Make it faster, or move it to a *.e2e.test.ts file: those are the e2e project (`just test-e2e`, and release-suites.yml on main before a release), which has no per-test budget and never runs on a pull request.",
    "CHANT_UNIT_TEST_BUDGET_MS changes the budget for a local run (0 turns it off).",
  ].join(" ");
}
