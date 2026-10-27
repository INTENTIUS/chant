/**
 * `pulumi-up`'s engine facts (INTENTIUS/chant#4555): the stack, the member,
 * the engine and the summary's counts, for the step's span and run record.
 */

import { describe, expect, test } from "vitest";
import { pulumiSummaryAttributes, pulumiTraceFacts } from "./trace-facts";
import { PulumiAppliedShapeError, type PulumiUpStepOutput } from "./pulumi-up";

const output: PulumiUpStepOutput = {
  member: "web/dev",
  stack: "dev",
  engine: "plunge",
  planDigest: `sha256:${"1".repeat(64)}`,
  fromWavePlan: true,
  outputs: {},
  summary: { resourceChanges: { create: 2, same: 5 }, durationSeconds: 12, result: "succeeded" },
};

describe("pulumi-up's trace facts (#4555)", () => {
  test("an up that applied gives the stack, the engine and the summary's counts", () => {
    expect(pulumiTraceFacts({ dir: "web", stack: "dev" }, { output })).toEqual({
      attributes: { stack: "dev", member: "web/dev", engine: "plunge", "up.from_wave_plan": true, "up.create": 2, "up.same": 5, "up.duration_s": 12, "up.result": "succeeded" },
    });
  });

  test("an up that ran steps the plan did not hold keeps its summary from the error", () => {
    const err = new PulumiAppliedShapeError("web/dev", ["a step"], { resourceChanges: { update: 1 }, result: "succeeded" });
    expect(pulumiTraceFacts({ dir: "web", stack: "dev", engine: "pulumi" }, { error: err })).toEqual({
      attributes: { stack: "dev", member: "web/dev", engine: "pulumi", "up.update": 1, "up.result": "succeeded" },
    });
  });

  test("a stock up with no summary gives no counts, and an error that says nothing gives the stack alone", () => {
    expect(pulumiSummaryAttributes(undefined)).toEqual({});
    expect(pulumiTraceFacts({ dir: "web", stack: "dev" }, { error: new Error("boom") })).toEqual({ attributes: { stack: "dev" } });
  });
});
