/** The parallelism limit (#4625). Written for the ci-products post-merge pass. */

import { describe, expect, test } from "vitest";
import { mapLimited, parallelismProblem } from "./parallelism";

describe("mapLimited", () => {
  test("never runs more than the limit at once, and keeps the order", async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimited([5, 1, 4, 2, 3], 2, async (n) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(most).toBe(2);
  });

  test("no limit runs them all at once", async () => {
    let most = 0;
    let running = 0;
    await mapLimited([1, 2, 3], undefined, async () => {
      running++;
      most = Math.max(most, running);
      await Promise.resolve();
      running--;
    });
    expect(most).toBe(3);
  });
});

test("parallelismProblem", () => {
  expect(parallelismProblem("parallelism", 4)).toBeUndefined();
  expect(parallelismProblem("parallelism", 0)).toMatch(/whole number of 1 or more/);
  expect(parallelismProblem("parallelism", 1.5)).toMatch(/whole number/);
});
