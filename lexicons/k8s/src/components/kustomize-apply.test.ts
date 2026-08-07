/**
 * `kustomize-apply` (#1548) — the render-then-apply leaf. What must hold:
 * the capability registers under its kind with the lexicon's own version
 * (#1505), the render command is exact and falls back to kubectl's vendored
 * kustomize, the rendered documents reach the applier INLINE (no temp file)
 * with the deploy-unit stack, and the rollback posture matches kubectl-apply
 * (server-side apply has no native undo).
 */
import { describe, test, expect } from "vitest";
import { createKustomizeApplyCapability, kustomizeApplyCapability, renderCommand, type KustomizeApplyInput } from "./kustomize-apply";
import { k8sCapabilityPlugin, K8S_VERB_FAMILIES } from "./capability-plugin";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import type { DeployContext } from "@intentius/chant/components/capability";

const ctx = { env: "dev" } as DeployContext;

const RENDERED = `apiVersion: v1
kind: Namespace
metadata:
  name: web
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  namespace: web
spec:
  replicas: 1
`;

describe("kustomize-apply capability (#1548)", () => {
  test("registers on the k8s plugin, in the apply family, at the package's own version", () => {
    expect(isCapabilityPlugin(k8sCapabilityPlugin)).toBe(true);
    expect(k8sCapabilityPlugin.capabilities().map((c) => c.kind)).toContain("kustomize-apply");
    expect(K8S_VERB_FAMILIES.apply).toContain("kustomize-apply");
    // #1505 — never a stale literal.
    const { version } = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(k8sCapabilityPlugin.version).toBe(version);
  });

  test("rollback is needs-opt-out — a server-side apply keeps no previous state", () => {
    expect(kustomizeApplyCapability.rollbackPolicy).toBe("needs-opt-out");
  });

  test("renders with kustomize build and hands the parsed documents to the applier inline", async () => {
    const commands: string[] = [];
    const applierArgs: unknown[] = [];
    const cap = createKustomizeApplyCapability(
      async (command) => {
        commands.push(command);
        return { stdout: RENDERED };
      },
      async (args) => {
        applierArgs.push(args);
        return { fieldManager: "chant:web", applied: [], pruned: [] };
      },
    );

    await cap.run(ctx, { dir: "overlays/dev", stack: "web", delete: "owned-only" } as KustomizeApplyInput as never);

    expect(commands).toEqual(["kustomize build 'overlays/dev'"]);
    expect(applierArgs).toHaveLength(1);
    const args = applierArgs[0] as { manifest: string; documents: unknown[]; environment: string; stack: string; deleteMode: string };
    expect(args.manifest).toBe("kustomize:overlays/dev"); // a label, not a path
    expect(args.documents).toHaveLength(2);
    expect((args.documents[1] as { kind: string }).kind).toBe("Deployment");
    expect(args.environment).toBe("dev");
    expect(args.stack).toBe("web");
    expect(args.deleteMode).toBe("owned-only");
  });

  test("falls back to kubectl's vendored kustomize when the binary is missing", async () => {
    const commands: string[] = [];
    const cap = createKustomizeApplyCapability(
      async (command) => {
        commands.push(command);
        if (command.startsWith("kustomize ")) throw new Error("spawn kustomize ENOENT");
        return { stdout: RENDERED };
      },
      async () => ({ fieldManager: "chant", applied: [], pruned: [] }),
    );
    await cap.run(ctx, { dir: "overlays/dev" } as KustomizeApplyInput as never);
    expect(commands).toEqual([renderCommand("overlays/dev", "kustomize"), renderCommand("overlays/dev", "kubectl")]);
  });

  test("a render failure that is NOT a missing binary propagates — a broken overlay is not silently retried", async () => {
    const cap = createKustomizeApplyCapability(
      async () => {
        throw new Error("accumulating resources: missing base ../common");
      },
      async () => ({ fieldManager: "chant", applied: [], pruned: [] }),
    );
    await expect(cap.run(ctx, { dir: "overlays/dev" } as KustomizeApplyInput as never)).rejects.toThrow("missing base");
  });
});
