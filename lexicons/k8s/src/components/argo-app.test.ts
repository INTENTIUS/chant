/**
 * `argo-app` (#1549 piece 2) — the Argo CD deploy leaf. What must hold: the
 * capability registers under its kind in the gitops family, the apply goes
 * through the SAME applier delegation kubectl-apply uses (env + stack +
 * deleteMode), the wait runs `waitForArgoSync` once per applied Application
 * (and only for Applications), a manifest with no Application is an error
 * not a silent no-wait, and the stack is the deploy unit core's status walk
 * reads.
 */
import { describe, test, expect } from "vitest";
import { createArgoAppCapability, argoAppCapability, type ArgoAppInput } from "./argo-app";
import { k8sCapabilityPlugin, K8S_VERB_FAMILIES } from "./capability-plugin";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import type { DeployContext } from "@intentius/chant/components/capability";

const ctx = { env: "dev" } as DeployContext;

const APP_REF = { apiVersion: "argoproj.io/v1alpha1", kind: "Application", name: "web", namespace: "argocd" };
const PROJECT_REF = { apiVersion: "argoproj.io/v1alpha1", kind: "AppProject", name: "team" };

describe("argo-app capability (#1549 piece 2)", () => {
  test("registers on the k8s plugin, in the gitops family", () => {
    expect(isCapabilityPlugin(k8sCapabilityPlugin)).toBe(true);
    expect(k8sCapabilityPlugin.capabilities().map((c) => c.kind)).toContain("argo-app");
    expect(K8S_VERB_FAMILIES.gitops).toContain("argo-app");
  });

  test("rollback is needs-opt-out — a server-side apply keeps no previous state", () => {
    expect(argoAppCapability.rollbackPolicy).toBe("needs-opt-out");
  });

  test("applies through the kubectl-apply delegation, then waits Healthy+Synced on each Application only", async () => {
    const applierArgs: unknown[] = [];
    const waited: unknown[] = [];
    const cap = createArgoAppCapability(
      async (args) => {
        applierArgs.push(args);
        return { fieldManager: "chant:gitops", applied: [PROJECT_REF, APP_REF], pruned: [] };
      },
      async (args) => {
        waited.push(args);
        return { health: "Healthy", sync: "Synced" };
      },
    );

    const outcome = await cap.run(ctx, {
      manifest: "argo/app.yaml",
      stack: "gitops",
      delete: "owned-only",
      intervalMs: 500,
    } as ArgoAppInput as never);

    // The exact args kubectl-apply hands the shared applier — same path, same stamping.
    expect(applierArgs).toEqual([
      { manifest: "argo/app.yaml", environment: "dev", stack: "gitops", deleteMode: "owned-only" },
    ]);
    // One wait, for the Application — the AppProject applies but is not synced on.
    expect(waited).toEqual([{ appName: "web", namespace: "argocd", intervalMs: 500 }]);
    expect(outcome.synced).toEqual([{ name: "web", namespace: "argocd", health: "Healthy", sync: "Synced" }]);
    expect(outcome.fieldManager).toBe("chant:gitops");
  });

  test("REST-API wait knobs (server/authToken/insecure) and context pass through to waitForArgoSync", async () => {
    const waited: unknown[] = [];
    const cap = createArgoAppCapability(
      async () => ({ fieldManager: "chant", applied: [APP_REF], pruned: [] }),
      async (args) => {
        waited.push(args);
        return { health: "Healthy", sync: "Synced" };
      },
    );
    await cap.run(ctx, {
      manifest: "argo/app.yaml",
      context: "kind-dev",
      server: "https://argocd.example.com",
      authToken: "t0ken",
      insecure: true,
    } as ArgoAppInput as never);
    expect(waited).toEqual([
      {
        appName: "web",
        namespace: "argocd",
        server: "https://argocd.example.com",
        authToken: "t0ken",
        insecure: true,
        context: "kind-dev",
      },
    ]);
  });

  test("an Application without a namespace waits in argocd, the controller's default", async () => {
    const waited: Array<{ namespace?: string }> = [];
    const cap = createArgoAppCapability(
      async () => ({
        fieldManager: "chant",
        applied: [{ apiVersion: "argoproj.io/v1alpha1", kind: "Application", name: "web" }],
        pruned: [],
      }),
      async (args) => {
        waited.push(args);
        return { health: "Healthy", sync: "Synced" };
      },
    );
    await cap.run(ctx, { manifest: "argo/app.yaml" } as ArgoAppInput as never);
    expect(waited[0]?.namespace).toBe("argocd");
  });

  test("a manifest that applied no Application is an error, not a silent no-wait", async () => {
    const cap = createArgoAppCapability(
      async () => ({ fieldManager: "chant", applied: [PROJECT_REF], pruned: [] }),
      async () => ({ health: "Healthy", sync: "Synced" }),
    );
    await expect(cap.run(ctx, { manifest: "argo/project.yaml" } as ArgoAppInput as never)).rejects.toThrow(
      /no argoproj\.io Application/,
    );
  });

  test("a failed sync propagates — the step does not report success past a Degraded app", async () => {
    const cap = createArgoAppCapability(
      async () => ({ fieldManager: "chant", applied: [APP_REF], pruned: [] }),
      async () => {
        throw new Error('Argo Application "web" reached a terminal unhealthy state');
      },
    );
    await expect(cap.run(ctx, { manifest: "argo/app.yaml" } as ArgoAppInput as never)).rejects.toThrow(
      /terminal unhealthy state/,
    );
  });

  test("the stack field is the deploy unit core's status walk reads (#1549 piece 2)", async () => {
    const { deployUnits } = await import("@intentius/chant/components/deploy-units");
    const units = deployUnits([
      { phase: "Apply", steps: [{ kind: "argo-app", manifest: "argo/app.yaml", stack: "gitops" }] } as never,
    ]);
    expect(units).toEqual([{ unit: "gitops", lexicon: "k8s" }]);
  });
});
