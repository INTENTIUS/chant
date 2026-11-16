import { availableParallelism, loadavg } from "node:os";
import { expect, test } from "vitest";

// Run only by test/unit-test-budget.e2e.test.ts, under a budget of a few hundred milliseconds.
test("a quick test passes", () => {
  expect(1 + 1).toBe(2);
});

test("a slow test goes over the budget", async () => {
  // The budget grows with machine load (#5221), so the wait grows with it and stays over the 500ms budget.
  const factor = Math.max(1, loadavg()[0] / availableParallelism());
  await new Promise((done) => setTimeout(done, 1_000 + 1_000 * factor));
  expect(true).toBe(true);
});
