/**
 * #4032: the trace budget's arithmetic. The timing itself runs in CI's check
 * job, on the whole repository; here only the median, the ratio and the
 * verdict, and the arguments.
 */

import { describe, expect, test } from "vitest";
import { DEFAULT_TARGETS, judge, median, parseArgs, TRACE_BUDGET_RATIO } from "./bench-trace";

describe("bench-trace (#4032)", () => {
  test("median of odd and even counts, unaffected by order", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  test("a target over the ratio fails the run, one at the ratio passes", () => {
    const r = judge(3, [100, 1000, 110], new Map([
      ["small", [300, 330, 5000]],
      ["big", [400, 340, 9000]],
    ]));
    expect(r.status.medianMs).toBe(110);
    expect(r.targets.map((t) => [t.target, t.medianMs, t.withinBudget])).toEqual([
      ["small", 330, true],
      ["big", 400, false],
    ]);
    expect(r.ok).toBe(false);
  });

  test("arguments: defaults, repeated targets, and refusals", () => {
    expect(parseArgs([])).toEqual({ runs: 5, budget: TRACE_BUDGET_RATIO, env: "prod", targets: DEFAULT_TARGETS, chant: null, json: false });
    expect(parseArgs(["--target", "a", "--target", "b#c", "--runs", "3", "--budget", "2.5", "--json"])).toMatchObject({ runs: 3, budget: 2.5, targets: ["a", "b#c"], json: true });
    expect(() => parseArgs(["--runs", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--budget"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });
});
