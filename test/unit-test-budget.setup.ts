import { availableParallelism, loadavg } from "node:os";
import { relative, resolve } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { loadFactor, overBudgetMessage, unitTestBudgetForFile, unitTestBudgetMs } from "./unit-test-budget";

/**
 * The per-test time budget for the `unit` vitest project (chant #2817).
 *
 * Pull request CI runs the unit tests as shards, and one slow test sets the
 * length of its shard, which every PR waits on. A unit test that takes longer
 * than the budget (5s by default, #3793) fails here with a message naming the
 * budget. End-to-end tests belong in a `*.e2e.test.ts` file, which the `e2e`
 * project runs in release-suites.yml with no budget.
 *
 * The time counted is the test and its beforeEach/afterEach hooks, the same span
 * vitest reports for the test. A file's beforeAll is not counted.
 *
 * The budget scales with machine load (#5221): the test gets its budget times
 * `loadFactor(load, cores)`, with the larger of the one-minute load average
 * read when the test started and when it ended. A runner at or under its core
 * count keeps the plain budget.
 *
 * A test in one of the named slow files (`SLOW_UNIT_TEST_FILES`, #4472) has
 * that file's higher budget; every other test has the run's.
 */
const budget = unitTestBudgetMs(process.env);
const repoRoot = resolve(import.meta.dirname, "..");
const started = new WeakMap<object, { at: number; load: number }>();

beforeEach((ctx) => {
  started.set(ctx.task, { at: performance.now(), load: loadavg()[0] ?? 0 });
});

afterEach((ctx) => {
  const begin = started.get(ctx.task);
  if (begin === undefined || budget === 0) return;
  const elapsed = performance.now() - begin.at;
  const filepath = ctx.task.file?.filepath;
  const file = filepath === undefined ? undefined : relative(repoRoot, filepath).replaceAll("\\", "/");
  const base = unitTestBudgetForFile(file, budget);
  const cpus = availableParallelism();
  const load = { loadavg: Math.max(begin.load, loadavg()[0] ?? 0), cpus };
  const limit = base * loadFactor(load.loadavg, cpus);
  if (elapsed > limit) throw new Error(overBudgetMessage(ctx.task.name, elapsed, base, file, load));
});
