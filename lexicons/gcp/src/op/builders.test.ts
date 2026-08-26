/**
 * Typed step-builder wrappers (chant #1288 Stage 2) — see
 * `lexicons/k8s/src/op/builders.test.ts`'s module doc for what's asserted
 * and why.
 */

import { describe, test, expect } from "vitest";
import {
  gcpApply as gcpApplyOld,
  gcpDelete as gcpDeleteOld,
  flociGcpUp as flociGcpUpOld,
  flociGcpDown as flociGcpDownOld,
  stepOutput,
  type StepOutputRef,
} from "@intentius/chant/op";
import { gcpApply, gcpDelete, flociGcpUp, flociGcpDown } from "./builders";

describe("gcp typed step builders (#1288 Stage 2)", () => {
  test("gcpApply: identical ActivityStep to core's original for a minimal call", () => {
    expect(gcpApply("dist/manifest.yaml")).toEqual(gcpApplyOld("dist/manifest.yaml"));
  });

  test("gcpApply: identical ActivityStep with opts", () => {
    const opts = { project: "my-project", prune: true };
    expect(gcpApply("dist/manifest.yaml", opts)).toEqual(gcpApplyOld("dist/manifest.yaml", opts));
  });

  test("gcpDelete: identical ActivityStep to core's original", () => {
    expect(gcpDelete("dist/manifest.yaml")).toEqual(gcpDeleteOld("dist/manifest.yaml"));
  });

  test("flociGcpUp/flociGcpDown: identical ActivityStep to core's original", () => {
    expect(flociGcpUp()).toEqual(flociGcpUpOld());
    expect(flociGcpDown()).toEqual(flociGcpDownOld());
  });

  test("gcpApply: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("resolve-project", "project");
    const step = gcpApply("dist/manifest.yaml", { project: ref });
    expect(step.args?.project).toBe(ref);
  });

  test("gcpApply: .out is reachable when an id is given", () => {
    const step = gcpApply("dist/manifest.yaml", { id: "apply" });
    const ref: StepOutputRef = step.out.applied;
    expect(ref.step).toBe("apply");
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — "projectId" is not a key of GcpApplyArgs (the field is `project`).
  gcpApply("dist/manifest.yaml", { projectId: "my-project" });

  // @ts-expect-error — prune must be a boolean.
  gcpApply("dist/manifest.yaml", { prune: "true" });
}
void _typeChecksOnly;
