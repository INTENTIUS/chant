/**
 * Typed step-builder wrapper (chant #1288 Stage 2) — see
 * `lexicons/k8s/src/op/builders.test.ts`'s module doc for what's asserted
 * and why.
 */

import { describe, test, expect } from "vitest";
import { gitlabPipeline as gitlabPipelineOld, stepOutput, type StepOutputRef } from "@intentius/chant/op";
import { gitlabPipeline } from "./builders";

describe("gitlab typed step builder (#1288 Stage 2)", () => {
  test("gitlabPipeline: identical ActivityStep to core's original for a minimal call", () => {
    expect(gitlabPipeline("alb-api")).toEqual(gitlabPipelineOld("alb-api"));
  });

  test("gitlabPipeline: identical ActivityStep with opts", () => {
    const opts = { ref: "main", intervalMs: 15000, profile: "fastIdempotent" as const };
    expect(gitlabPipeline("alb-api", opts)).toEqual(gitlabPipelineOld("alb-api", opts));
  });

  test("gitlabPipeline: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("resolve-ref", "sha");
    const step = gitlabPipeline("alb-api", { ref });
    expect(step.args?.ref).toBe(ref);
  });

  test("gitlabPipeline: .out is reachable when an id is given", () => {
    const step = gitlabPipeline("alb-api", { id: "pipeline" });
    const ref: StepOutputRef = step.out.name;
    expect(ref.step).toBe("pipeline");
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — "project" is not a key of GitlabPipelineArgs (the
  // field is `name`, and it's positional here besides).
  gitlabPipeline("alb-api", { project: "group/other" });

  // @ts-expect-error — intervalMs must be a number.
  gitlabPipeline("alb-api", { intervalMs: "15000" });
}
void _typeChecksOnly;
