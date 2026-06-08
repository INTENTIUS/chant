import { describe, test, expect } from "vitest";
import { resolve } from "node:path";
import { policyGate } from "./policy";

// The #201 org-policy example: a compliant workload + a policy pack
// (ORG-COST-CENTER all-envs, ORG-PROD-TLS prod-only). policyGate builds it and
// runs the policies — passing in dev, blocking in prod.
const orgPolicySrc = resolve(import.meta.dirname, "../../../../k8s/examples/org-policy/src");

describe("policyGate activity (#201 T4 — gate an apply on policy)", () => {
  test("passes when policy is satisfied (no env, and dev)", async () => {
    await expect(policyGate({ path: orgPolicySrc })).resolves.toBeUndefined();
    await expect(policyGate({ path: orgPolicySrc, env: "dev" })).resolves.toBeUndefined();
  }, 30_000);

  test("blocks the apply on a prod policy violation", async () => {
    await expect(policyGate({ path: orgPolicySrc, env: "prod" })).rejects.toThrow(/ORG-PROD-TLS/);
  }, 30_000);
});
