/**
 * Typed step-builder wrappers (chant #1288 Stage 2) — see
 * `lexicons/k8s/src/op/builders.test.ts`'s module doc for what's asserted
 * and why.
 */

import { describe, test, expect } from "vitest";
import { awsApply as awsApplyOld, awsDelete as awsDeleteOld, flociUp as flociUpOld, flociDown as flociDownOld, stepOutput, type StepOutputRef } from "@intentius/chant/op";
import { awsApply, awsDelete, flociUp, flociDown } from "./builders";

describe("aws typed step builders (#1288 Stage 2)", () => {
  test("awsApply: identical ActivityStep to core's original", () => {
    const opts = { stackName: "my-stack" };
    expect(awsApply("dist/template.json", opts)).toEqual(awsApplyOld("dist/template.json", opts));
  });

  test("awsApply: identical ActivityStep with more opts", () => {
    const opts = { stackName: "my-stack", region: "us-west-2", capabilities: ["CAPABILITY_NAMED_IAM"], profile: "fastIdempotent" as const };
    expect(awsApply("dist/template.json", opts)).toEqual(awsApplyOld("dist/template.json", opts));
  });

  test("awsDelete: identical ActivityStep to core's original", () => {
    const opts = { stackName: "my-stack" };
    expect(awsDelete("dist/template.json", opts)).toEqual(awsDeleteOld("dist/template.json", opts));
  });

  test("flociUp/flociDown: identical ActivityStep to core's original", () => {
    expect(flociUp()).toEqual(flociUpOld());
    expect(flociUp({ port: 4567 })).toEqual(flociUpOld({ port: 4567 }));
    expect(flociDown()).toEqual(flociDownOld());
  });

  test("awsApply: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("resolve-region", "region");
    const step = awsApply("dist/template.json", { stackName: "my-stack", region: ref });
    expect(step.args?.region).toBe(ref);
  });

  test("awsApply: .out is reachable when an id is given", () => {
    const step = awsApply("dist/template.json", { stackName: "my-stack", id: "apply" });
    const ref: StepOutputRef = step.out.releaseName;
    expect(ref.step).toBe("apply");
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — stackName is required (the activity fails without it);
  // omitting opts entirely is no longer a way around that.
  awsApply("dist/template.json");

  // @ts-expect-error — "stackname" (wrong case) is not a key of AwsApplyArgs.
  awsApply("dist/template.json", { stackname: "my-stack" });

  // @ts-expect-error — capabilities must be string[], not a single string.
  awsApply("dist/template.json", { stackName: "my-stack", capabilities: "CAPABILITY_NAMED_IAM" });

  // @ts-expect-error — port must be a number.
  flociUp({ port: "4566" });
}
void _typeChecksOnly;
