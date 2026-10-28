/** The flags of the component plan-wave and apply-wave steps and of `chant lock --keep` (#4588). */

import { describe, expect, test } from "vitest";
import { parseArgs } from "./parse-args";

describe("component wave steps and comment locks (#4588)", () => {
  test("plan-wave and apply-wave take the runs, plans and outputs files", () => {
    const args = parseArgs(["components", "apply-wave", "--runs", "r.json", "--plans", "p.json", "--wave-outputs", "o.json", "--base", "abc", "--env", "prod"]);
    expect([args.runsFile, args.plansFile, args.waveOutputs]).toEqual(["r.json", "p.json", "o.json"]);
    expect(() => parseArgs(["components", "plan-wave", "--runs", "--plans", "p.json"])).toThrow(/--runs needs a file/);
  });

  test("chant lock --keep", () => {
    expect(parseArgs(["lock", "--keep", "--pr", "7"]).keepLocks).toBe(true);
  });
});
