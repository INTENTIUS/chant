/**
 * Plan flags through the capability contract (#4627): a capability says it
 * takes `refresh` and `targetDependents`, a component is refused by name
 * when one of its steps cannot, the context carries them, and the member's
 * digest binds them. Written for the ci-products post-merge pass.
 */
import { describe, expect, test } from "vitest";
import { CapabilityRegistry, PlanFlagRefusedError, planFlagRefusal, type Capability, type CapabilityPlan } from "./capability";
import { assertPlanFlagsAccepted, deployContext, type DriverComponent } from "./driver";
import { bindPlanFlags } from "./wave-plan";

const cap = (kind: string, planFlags?: Capability<never, unknown>["planFlags"]) =>
  ({ kind, ...(planFlags ? { planFlags } : {}), async run() { return {}; } }) as unknown as Capability<never, unknown>;
const registry = new CapabilityRegistry().register(cap("both", { refresh: "accept", targetDependents: "accept" })).register(cap("refresh-only", { refresh: "accept", targetDependents: { refuse: "no flag for it" } })).register(cap("silent"));
const component = (kind: string): DriverComponent => ({ name: "c", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind, root: "r" }] }] });

describe("plan flags (#4627)", () => {
  test("a capability's refusal, its own reason or one naming the verb", () => {
    expect(planFlagRefusal(cap("both", { refresh: "accept" }), "refresh")).toBeUndefined();
    expect(planFlagRefusal(cap("x", { targetDependents: { refuse: "why" } }), "targetDependents")).toBe("why");
    expect(planFlagRefusal(cap("silent"), "refresh")).toBe("silent does not say it can plan with --refresh");
  });

  test("a component is refused by name and flag", () => {
    expect(() => assertPlanFlagsAccepted(component("both"), registry, { refresh: true, targetDependents: true })).not.toThrow();
    expect(() => assertPlanFlagsAccepted(component("refresh-only"), registry, { targetDependents: true })).toThrow(PlanFlagRefusedError);
    expect(() => assertPlanFlagsAccepted(component("refresh-only"), registry, { targetDependents: true })).toThrow('component "c": refresh-only refuses --target-dependents: no flag for it');
    expect(() => assertPlanFlagsAccepted(component("silent"), registry, { refresh: true })).toThrow(/refuses --refresh/);
    expect(() => assertPlanFlagsAccepted(component("silent"), registry, {})).not.toThrow();
  });

  test("the context carries refresh for every component, and target dependents only with targets", () => {
    expect(deployContext({ env: "dev", refresh: true, targetDependents: true, targets: { a: ["x"] } }, "a")).toMatchObject({ refresh: true, targetDependents: true, targets: ["x"] });
    expect(deployContext({ env: "dev", refresh: true, targetDependents: true, targets: { a: ["x"] } }, "b")).toEqual({ env: "dev", component: "b", refresh: true });
  });

  test("the digest binds each flag, and a plain plan keeps its own", () => {
    const planned = { member: "m", planDigest: "sha256:" + "1".repeat(64), changeSet: { member: { member: "m", lexicon: "x", planner: "chant", status: "planned" as const, planDigest: "sha256:" + "1".repeat(64), holes: [] }, entries: [] } } as unknown as CapabilityPlan;
    expect(bindPlanFlags({}, planned)).toBe(planned);
    const refreshed = bindPlanFlags({ refresh: true }, planned);
    const widened = bindPlanFlags({ targetDependents: true }, planned);
    expect(refreshed.planDigest).not.toBe(planned.planDigest);
    expect(widened.planDigest).not.toBe(refreshed.planDigest);
    expect(refreshed.changeSet!.member.planDigest).toBe(refreshed.planDigest);
  });
});
