import { afterEach, beforeEach } from "vitest";
import { overBudgetMessage, unitTestBudgetMs } from "./unit-test-budget";

/**
 * The per-test time budget for the `unit` vitest project (chant #2817).
 *
 * CI runs the unit tests as four shards, and one slow test sets the length of
 * its shard, which every PR and every release waits on. A unit test that takes
 * longer than the budget (15s by default) fails here with a message naming the
 * budget. End-to-end tests belong in a `*.e2e.test.ts` file, which the `e2e`
 * project runs in its own CI job with no budget.
 *
 * The time counted is the test and its beforeEach/afterEach hooks, the same span
 * vitest reports for the test. A file's beforeAll is not counted.
 */
const budget = unitTestBudgetMs(process.env);
const started = new WeakMap<object, number>();

beforeEach((ctx) => {
  started.set(ctx.task, performance.now());
});

afterEach((ctx) => {
  const start = started.get(ctx.task);
  if (start === undefined || budget === 0) return;
  const elapsed = performance.now() - start;
  if (elapsed > budget) throw new Error(overBudgetMessage(ctx.task.name, elapsed, budget));
});
