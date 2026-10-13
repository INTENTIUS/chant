import { describe, expect, test } from "vitest";
import {
  ConvergeOp,
  eq,
  isActivityContract,
  loadActivities,
  loadActivityContracts,
  report,
  stepOutput,
  validateActivitySteps,
  validateStepOutputRefs,
  when,
  type ActivityContract,
  type ResourceSymptom,
  type StepOutputRef,
} from "@intentius/chant/op";
import * as contracts from "./activity-contracts";
import * as activities from "./activities";
import { collectorAudit, collectorHealthObserve, otelcolComponents, otelcolValidate } from "./builders";
import { CollectorAuditOp } from "./audit-op";

const CONTRACTS: Map<string, ActivityContract> = new Map(
  Object.values(contracts).filter(isActivityContract).map((c) => [c.name, c]),
);

const op = (steps: unknown[]) => ({ name: "check", phases: [{ name: "Check", steps: steps as never[] }] });

describe("otel activity contracts (#3369)", () => {
  test("every exported activity has a contract with a return schema, and nothing else is exported", () => {
    for (const [key, value] of Object.entries(contracts)) {
      expect(isActivityContract(value), `${key} is not an ActivityContract`).toBe(true);
      expect((value as ActivityContract).returns).toBeDefined();
    }
    const fns = Object.entries(activities).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
    expect([...CONTRACTS.keys()].sort()).toEqual(fns);
    expect(fns).toEqual(["collectorAudit", "collectorHealthObserve", "otelcolComponents", "otelcolValidate"]);
  });

  test("the builders' steps validate, and a misspelled key is an error", () => {
    const steps = [
      otelcolValidate({ config: "dist/collector.yaml" }),
      otelcolValidate({ config: "dist/collector.yaml", version: "v0.131.0", bin: "/opt/otelcol-contrib" }),
      otelcolComponents({ config: "dist/collector.yaml" }),
      collectorAudit({ mode: "pull-request" }),
    ];
    expect(validateActivitySteps(op(steps), CONTRACTS)).toEqual([]);
    const issues = validateActivitySteps(op([{ kind: "activity", fn: "otelcolValidate", args: { conifg: "x.yaml" } }]), CONTRACTS);
    expect(issues.some((i) => i.message.includes("conifg"))).toBe(true);
  });

  test("ConvergeOp({ observe: collectorHealthObserve }) passes OPS012 and OPS013", () => {
    const { op: converge } = ConvergeOp({
      name: "collector-health",
      env: "local",
      schedule: "*/5 * * * *",
      observe: collectorHealthObserve({ collectors: [{ name: "gateway", config: "dist/gateway.yaml", host: "127.0.0.1" }] }),
      rules: [when<ResourceSymptom>(eq("status", "drifted"), report("collector unhealthy"), { id: "collector-down", why: "say so" })],
    });
    expect(validateActivitySteps(converge.props as never, CONTRACTS)).toEqual([]);
    expect(validateStepOutputRefs(converge.props as never, CONTRACTS)).toEqual([]);
    // Without the contracts the observer's output has no schema (OPS013).
    expect(validateStepOutputRefs(converge.props as never, new Map()).length).toBeGreaterThan(0);
  });

  test("CollectorAuditOp is one collectorAudit step, its findings the run's outcome", () => {
    const { op: audit } = CollectorAuditOp({ name: "collector-audit", schedule: "0 6 * * 1", onFinding: "pull-request" });
    const props = audit.props as unknown as { schedule?: unknown; phases: Array<{ steps: Array<{ fn: string; args: Record<string, unknown>; outcomeAttribute: unknown }> }> };
    expect(props.schedule).toEqual({ cron: "0 6 * * 1", overlap: "skip" });
    expect(props.phases[0].steps[0]).toMatchObject({ fn: "collectorAudit", args: { mode: "pull-request" }, outcomeAttribute: { name: "Findings", from: "findings" } });
    expect(validateActivitySteps(props as never, CONTRACTS)).toEqual([]);
    expect(CollectorAuditOp({ name: "a" }).op.props).not.toHaveProperty("schedule");
  });

  test("builders route profile and id to the step, and take step-output refs", () => {
    const s = otelcolValidate({ config: "x.yaml", id: "validate", profile: "longInfra" });
    expect(s).toMatchObject({ fn: "otelcolValidate", args: { config: "x.yaml" }, id: "validate", profile: "longInfra" });
    const ref: StepOutputRef = s.out.version;
    expect(ref.step).toBe("validate");
    const t = otelcolComponents({ config: stepOutput("render", "path") });
    expect(t.args?.config).toMatchObject({ step: "render" });
    expect(collectorAudit().profile).toBe("fastIdempotent");
  });

  test("loadActivities and loadActivityContracts find them by the otel lexicon's name", async () => {
    const acts = await loadActivities(["otel"]);
    for (const fn of ["otelcolValidate", "otelcolComponents", "collectorHealthObserve", "collectorAudit"]) expect(acts.has(fn), fn).toBe(true);
    const loaded = await loadActivityContracts(["otel"]);
    expect(loaded.get("collectorHealthObserve")?.returns).toBeDefined();
  });
});

// ── Compile-time only ────────────────────────────────────────────────
function _typeChecksOnly(): void {
  // @ts-expect-error: config is required.
  otelcolValidate({});
  // @ts-expect-error: a collector needs a name.
  collectorHealthObserve({ collectors: [{ config: "x.yaml" }] });
  // @ts-expect-error: the test seam is not an authoring option.
  otelcolComponents({ config: "x.yaml", _exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  // @ts-expect-error: mode is report, issue or pull-request.
  collectorAudit({ mode: "merge-request" });
}
void _typeChecksOnly;
