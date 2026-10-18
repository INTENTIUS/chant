/**
 * #4025: the overlap budget's arguments and the clone's work records. The
 * timing itself runs in CI's check job, on a clone of the whole repository.
 */

import { describe, expect, test } from "vitest";
import { OVERLAP_BUDGET_RATIO, parseArgs, workRecord } from "./bench-overlap";

describe("bench-overlap (#4025)", () => {
  test("arguments: defaults and refusals", () => {
    expect(parseArgs([])).toEqual({ runs: 5, budget: OVERLAP_BUDGET_RATIO, env: "prod", json: false });
    expect(parseArgs(["--runs", "3", "--budget", "0.6", "--json"])).toMatchObject({ runs: 3, budget: 0.6, json: true });
    expect(() => parseArgs(["--runs", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--budget", "-1"])).toThrow(/positive number/);
    expect(() => parseArgs(["--target", "x"])).toThrow(/unknown argument/);
  });

  test("a bench work item implements no decision, so it is in flight", () => {
    const text = workRecord("W-001");
    const data = JSON.parse(text.split("---\n")[1]);
    expect(data).toMatchObject({ id: "W-001", state: "in-progress", implements: [] });
  });
});
