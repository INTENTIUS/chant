import { describe, test, expect } from "vitest";
import { createKubectlApplyCapability, k8sCapabilityPlugin } from "../index";
import type { KubectlApplyArgs } from "../op/activities/kubectl";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";

describe("kubectl-apply capability (#1495 piece 2)", () => {
  test("the plugin satisfies the CapabilityPlugin contract and registers the verb", () => {
    expect(isCapabilityPlugin(k8sCapabilityPlugin)).toBe(true);
    const kinds = k8sCapabilityPlugin.capabilities().map((c) => c.kind);
    expect(kinds).toContain("kubectl-apply");
  });

  test("run delegates to the server-side apply with the component's env and the step's stack", async () => {
    let seen: KubectlApplyArgs | undefined;
    const cap = createKubectlApplyCapability(async (args) => {
      seen = args;
      return { applied: [], pruned: [], fieldManager: "chant:kubemicrovm-ops" } as never;
    });
    await cap.run({ env: "dev", component: "workload" }, { manifest: "k8s.yaml", stack: "kubemicrovm-ops", delete: "owned-only" });
    expect(seen).toEqual({ manifest: "k8s.yaml", environment: "dev", stack: "kubemicrovm-ops", deleteMode: "owned-only" });
  });

  test("a mutating verb with no safe undo declares needs-opt-out for COMP003", () => {
    expect(createKubectlApplyCapability().rollbackPolicy).toBe("needs-opt-out");
  });

  test("the stack field is the deploy unit core's status walk reads (#1495 piece 1)", async () => {
    const { deployUnits } = await import("@intentius/chant/components/deploy-units");
    const units = deployUnits([
      { phase: "Apply", steps: [{ kind: "kubectl-apply", manifest: "k8s.yaml", stack: "kubemicrovm-ops" }] } as never,
    ]);
    expect(units).toEqual([{ unit: "kubemicrovm-ops", lexicon: "k8s" }]);
  });
});
