import { describe, test, expect } from "vitest";
import { createKubectlApplyCapability, k8sCapabilityPlugin } from "../index";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";

describe("kubectl-apply capability (#1495 piece 2)", () => {
  test("the plugin satisfies the CapabilityPlugin contract and registers the verb", () => {
    expect(isCapabilityPlugin(k8sCapabilityPlugin)).toBe(true);
    const kinds = k8sCapabilityPlugin.capabilities().map((c) => c.kind);
    expect(kinds).toContain("kubectl-apply");
  });

  test("the plugin's version is the lexicon package's own, not a literal (#1505)", async () => {
    const { readFileSync } = await import("node:fs");
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    expect(k8sCapabilityPlugin.version).toBe(version);
  });

  test("run delegates to the server-side apply with the component's env and the step's stack", async () => {
    let seen: unknown;
    const cap = createKubectlApplyCapability(async (args) => {
      seen = args;
      return { applied: [], pruned: [], fieldManager: "chant:kubemicrovm-ops" };
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

describe("kubectl-apply with a release (#3061, ws-081)", () => {
  const stamped = () => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "api" },
    spec: {
      template: {
        metadata: { labels: { app: "api" } },
        spec: {
          containers: [
            {
              name: "api",
              image: "x",
              env: [
                { name: "CHANT_RELEASE_ATTRIBUTES", valueFrom: { fieldRef: { fieldPath: "metadata.annotations['chant.intentius.io/release-attributes']" } } },
                { name: "OTEL_RESOURCE_ATTRIBUTES", value: "chant.decl=api$(CHANT_RELEASE_ATTRIBUTES)" },
              ],
            },
          ],
        },
      },
    },
  });
  const plain = () => ({ apiVersion: "v1", kind: "Service", metadata: { name: "api" }, spec: { ports: [{ port: 80 }] } });
  const release = { version: "sha256:abc", revision: "0123abc" };

  test("sets the release attributes on the pod template of each stamped workload it applies", async () => {
    let seen: { documents?: Record<string, any>[] } = {};
    const cap = createKubectlApplyCapability(
      async (args) => {
        seen = args as typeof seen;
        return { applied: [], pruned: [], fieldManager: "chant:x" };
      },
      () => [stamped(), plain()],
    );
    await cap.run({ env: "prod", component: "api", release }, { manifest: "k8s.yaml", stack: "x" });
    expect(seen.documents![0].spec.template.metadata).toEqual({
      labels: { app: "api" },
      annotations: { "chant.intentius.io/release-attributes": ",service.version=sha256%3Aabc,vcs.ref.head.revision=0123abc" },
    });
    expect(seen.documents![1]).toEqual(plain());
  });

  test("without a release, or with no stamped workload, it applies the manifest as read", async () => {
    const calls: Record<string, unknown>[] = [];
    let reads = 0;
    const cap = createKubectlApplyCapability(
      async (args) => {
        calls.push(args as Record<string, unknown>);
        return { applied: [], pruned: [], fieldManager: "chant:x" };
      },
      () => {
        reads++;
        return [plain()];
      },
    );
    await cap.run({ env: "prod", component: "api" }, { manifest: "k8s.yaml" });
    await cap.run({ env: "prod", component: "api", release }, { manifest: "k8s.yaml" });
    expect(reads).toBe(1);
    expect(calls.every((c) => !("documents" in c))).toBe(true);
  });

  test("the committed manifest is the same bytes after a release apply", async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { dump } = await import("js-yaml");
    const { readManifestDocuments } = await import("../op/activities/kubectl");
    const dir = mkdtempSync(join(tmpdir(), "chant-3061-"));
    try {
      const file = join(dir, "k8s.yaml");
      writeFileSync(file, `${dump(stamped())}---\n${dump(plain())}`);
      const before = readFileSync(file, "utf-8");
      let annotated = 0;
      const cap = createKubectlApplyCapability(async (args) => {
        annotated = (args.documents ?? []).filter((d: any) => d.spec?.template?.metadata?.annotations).length;
        return { applied: [], pruned: [], fieldManager: "chant:x" };
      }, readManifestDocuments);
      await cap.run({ env: "prod", component: "api", release }, { manifest: file });
      expect(annotated).toBe(1);
      expect(readFileSync(file, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
