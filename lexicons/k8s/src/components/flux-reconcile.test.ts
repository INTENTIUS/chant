/**
 * `flux-reconcile` (#1549 piece 2) — the Flux deploy leaf. What must hold:
 * the capability registers under its kind in the gitops family, the apply
 * goes through the SAME applier delegation kubectl-apply uses, the wait runs
 * the generic `waitForReady` once per applied Flux CR — sources before
 * reconcilers, non-Flux objects skipped — with the group/kind the #1554
 * readiness entries key on, a manifest with no Flux CR is an error, and the
 * stack is the deploy unit core's status walk reads.
 */
import { describe, test, expect } from "vitest";
import { createFluxReconcileCapability, fluxReconcileCapability, type FluxReconcileInput } from "./flux-reconcile";
import { k8sCapabilityPlugin, K8S_VERB_FAMILIES } from "./capability-plugin";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import type { DeployContext } from "@intentius/chant/components/capability";

const ctx = { env: "dev" } as DeployContext;

const KUSTOMIZATION = {
  apiVersion: "kustomize.toolkit.fluxcd.io/v1",
  kind: "Kustomization",
  name: "apps",
  namespace: "flux-system",
};
const GIT_REPO = {
  apiVersion: "source.toolkit.fluxcd.io/v1",
  kind: "GitRepository",
  name: "repo",
  namespace: "flux-system",
};
const HELM_RELEASE = {
  apiVersion: "helm.toolkit.fluxcd.io/v2",
  kind: "HelmRelease",
  name: "podinfo",
  namespace: "flux-system",
};
const NAMESPACE = { apiVersion: "v1", kind: "Namespace", name: "flux-system" };

describe("flux-reconcile capability (#1549 piece 2)", () => {
  test("registers on the k8s plugin, in the gitops family", () => {
    expect(isCapabilityPlugin(k8sCapabilityPlugin)).toBe(true);
    expect(k8sCapabilityPlugin.capabilities().map((c) => c.kind)).toContain("flux-reconcile");
    expect(K8S_VERB_FAMILIES.gitops).toContain("flux-reconcile");
  });

  test("rollback is needs-opt-out — a server-side apply keeps no previous state", () => {
    expect(fluxReconcileCapability.rollbackPolicy).toBe("needs-opt-out");
  });

  test("applies through the kubectl-apply delegation, then waits Ready on each Flux CR — sources first, non-Flux skipped", async () => {
    const applierArgs: unknown[] = [];
    const waited: Array<{ kind: string; group?: string }> = [];
    const cap = createFluxReconcileCapability(
      async (args) => {
        applierArgs.push(args);
        // Applied order: reconciler before its source, plus a plain Namespace.
        return { fieldManager: "chant:gitops", applied: [NAMESPACE, KUSTOMIZATION, GIT_REPO, HELM_RELEASE], pruned: [] };
      },
      async (args) => {
        waited.push(args);
        return {};
      },
    );

    const outcome = await cap.run(ctx, {
      manifest: "flux/",
      stack: "gitops",
      delete: "owned-only",
      intervalMs: 500,
    } as FluxReconcileInput as never);

    // The exact args kubectl-apply hands the shared applier — same path, same stamping.
    expect(applierArgs).toEqual([
      { manifest: "flux/", environment: "dev", stack: "gitops", deleteMode: "owned-only" },
    ]);
    // Source first (a Kustomization can't be Ready before its GitRepository has
    // an artifact), then the reconcilers in applied order; the Namespace is not waited on.
    expect(waited).toEqual([
      {
        kind: "GitRepository",
        name: "repo",
        namespace: "flux-system",
        group: "source.toolkit.fluxcd.io",
        environment: "dev",
        intervalMs: 500,
      },
      {
        kind: "Kustomization",
        name: "apps",
        namespace: "flux-system",
        group: "kustomize.toolkit.fluxcd.io",
        environment: "dev",
        intervalMs: 500,
      },
      {
        kind: "HelmRelease",
        name: "podinfo",
        namespace: "flux-system",
        group: "helm.toolkit.fluxcd.io",
        environment: "dev",
        intervalMs: 500,
      },
    ]);
    expect(outcome.ready).toEqual([GIT_REPO, KUSTOMIZATION, HELM_RELEASE]);
    expect(outcome.fieldManager).toBe("chant:gitops");
  });

  test("the group/kind handed to waitForReady key the #1554 readiness registry entries", async () => {
    // The registry is keyed "<group>/<kind>" — assert the pair the capability
    // passes resolves to the ConditionReasonMatch entry, not the generic default.
    const { readinessFor } = await import("../op/activities/wait-for-ready");
    const spec = readinessFor("kustomize.toolkit.fluxcd.io", "Kustomization");
    expect(spec.terminal).toBeDefined();
    expect(JSON.stringify(spec.terminal)).toContain("BuildFailed");
  });

  test("a manifest that applied no Flux CR is an error, not a silent no-wait", async () => {
    const cap = createFluxReconcileCapability(
      async () => ({ fieldManager: "chant", applied: [NAMESPACE], pruned: [] }),
      async () => ({}),
    );
    await expect(cap.run(ctx, { manifest: "k8s.yaml" } as FluxReconcileInput as never)).rejects.toThrow(
      /no Flux CR/,
    );
  });

  test("a wedged CR propagates — the step does not report success past a terminal Ready=False", async () => {
    const cap = createFluxReconcileCapability(
      async () => ({ fieldManager: "chant", applied: [KUSTOMIZATION], pruned: [] }),
      async () => {
        throw new Error("Kustomization/apps reached a terminal state");
      },
    );
    await expect(cap.run(ctx, { manifest: "flux/" } as FluxReconcileInput as never)).rejects.toThrow(
      /terminal state/,
    );
  });

  test("the stack field is the deploy unit core's status walk reads (#1549 piece 2)", async () => {
    const { deployUnits } = await import("@intentius/chant/components/deploy-units");
    const units = deployUnits([
      { phase: "Apply", steps: [{ kind: "flux-reconcile", manifest: "flux/", stack: "gitops" }] } as never,
    ]);
    expect(units).toEqual([{ unit: "gitops", lexicon: "k8s" }]);
  });
});
