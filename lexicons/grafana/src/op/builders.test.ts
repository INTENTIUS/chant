/**
 * The typed step builder (chant #1288 Stage 2): the ActivityStep it makes,
 * and the authoring-time type errors its `opts` type gives.
 */

import { describe, test, expect } from "vitest";
import { activity, stepOutput, type StepOutputRef } from "@intentius/chant/op";
import { grafanaApply } from "./builders";
import * as activities from "./activities";

describe("grafana typed step builder", () => {
  test("grafanaApply: the activity named as the module exports it, on the longInfra profile", () => {
    expect(grafanaApply("dist/grafana.json")).toEqual(activity("grafanaApply", { indexPath: "dist/grafana.json" }, { profile: "longInfra" }));
    expect(typeof activities.grafanaApply).toBe("function");
    expect(typeof activities.toApplyResult).toBe("function");
  });

  test("grafanaApply: opts are the activity's own arguments", () => {
    const step = grafanaApply("dist/grafana.json", { environment: "prod", prune: true, profile: "fastIdempotent" });
    expect(step.args).toEqual({ indexPath: "dist/grafana.json", environment: "prod", prune: true });
    expect(step.profile).toBe("fastIdempotent");
  });

  test("grafanaApply: accepts a StepOutputRef in a typed slot, and .out is reachable with an id", () => {
    const ref = stepOutput("resolve-env", "environment");
    expect(grafanaApply("dist/grafana.json", { environment: ref }).args?.environment).toBe(ref);
    const out: StepOutputRef = grafanaApply("dist/grafana.json", { id: "apply" }).out.applied;
    expect(out.step).toBe("apply");
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — "env" is not a key of GrafanaApplyArgs (the field is `environment`).
  grafanaApply("dist/grafana.json", { env: "prod" });

  // @ts-expect-error — prune must be a boolean.
  grafanaApply("dist/grafana.json", { prune: "true" });
}
void _typeChecksOnly;
