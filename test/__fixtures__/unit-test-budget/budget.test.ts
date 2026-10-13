import { expect, test } from "vitest";

// Run only by test/unit-test-budget.e2e.test.ts, under a budget of a few hundred milliseconds.
test("a quick test passes", () => {
  expect(1 + 1).toBe(2);
});

test("a slow test goes over the budget", async () => {
  await new Promise((done) => setTimeout(done, 1_500));
  expect(true).toBe(true);
});
