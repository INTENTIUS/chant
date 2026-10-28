import { describe, expect, test } from "vitest";
import { capabilityPolicyOf, isPolicyDeniedError } from "./wave-plan";

// chant#4541's pulumi-up marks a CrossGuard denial `policyDenied` and puts its
// findings, and advisory ones on the plan's artifact, in the gate-policy shape.
describe("a capability's policy findings (#4550)", () => {
  test("reads the policyDenied mark and its findings", () => {
    const err = Object.assign(new Error("denied"), { policyDenied: true as const, member: "shop/dev", findings: { denials: [{ rule: "crossguard.p.r", message: "no" }], holds: [], warnings: [] } });
    expect(isPolicyDeniedError(err)).toBe(true);
    expect(isPolicyDeniedError(new Error("x"))).toBe(false);
    expect(capabilityPolicyOf("shop/dev", err.findings, true)).toEqual({ member: "shop/dev", denied: true, denials: [{ rule: "crossguard.p.r", message: "no" }], holds: [], warnings: [] });
  });

  test("advisory findings on an artifact come back; none is undefined", () => {
    expect(capabilityPolicyOf("m", { denials: [], holds: [{ rule: "r", message: "advise" }], warnings: [] }, false)?.holds).toEqual([{ rule: "r", message: "advise" }]);
    expect(capabilityPolicyOf("m", { denials: [], holds: [], warnings: [] }, false)).toBeUndefined();
    expect(capabilityPolicyOf("m", undefined, false)).toBeUndefined();
  });
});
