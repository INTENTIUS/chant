import { describe, test, expect } from "vitest";
import { createKubectlApplyCapability, k8sCapabilityPlugin } from "../index";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { isPlanDigest } from "@intentius/chant/lifecycle/plan-digest";

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
        calls.push({ ...args });
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

describe("kubectl-apply plan: a server-side dry-run diff (#3998)", () => {
  type DryRun = import("./kubectl-apply").KubectlApplyDryRun;
  const web = { apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" };
  const deployment = () => ({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: "prod" }, spec: { replicas: 3 } });
  const unchanged = (): DryRun => ({ fieldManager: "chant:web", stack: "web", objects: [{ ref: web, action: "no-op", changes: [] }], deletes: [], retained: [] });
  const scaled = (to: number): DryRun => ({
    fieldManager: "chant:web",
    stack: "web",
    objects: [{ ref: web, action: "update", changes: [{ path: "spec.replicas", before: 3, after: to }] }],
    deletes: [],
    retained: [],
  });
  const noApply = async (): Promise<never> => {
    throw new Error("applied");
  };

  test("plan dry-runs the documents run would apply and answers the stack as the member", async () => {
    let seen: Record<string, unknown> = {};
    const cap = createKubectlApplyCapability(noApply, () => [deployment()], async (args) => {
      seen = args as never;
      return scaled(5);
    });
    const planned = await cap.plan!({ env: "prod", component: "api" }, { manifest: "k8s.yaml", stack: "web", delete: "owned-only" });
    expect(seen).toMatchObject({ manifest: "k8s.yaml", documents: [deployment()], environment: "prod", stack: "web", deleteMode: "owned-only" });
    expect(planned.member).toBe("web");
    expect(isPlanDigest(planned.planDigest)).toBe(true);
    expect(planned.changeSet!.member).toMatchObject({ member: "web", lexicon: "k8s", planner: "chant", status: "planned", planDigest: planned.planDigest, holes: [] });
    expect(planned.changeSet!.entries).toEqual([
      {
        member: "web",
        lexicon: "k8s",
        planner: "chant",
        address: "Deployment/prod/web",
        type: "apps/v1/Deployment",
        name: "web",
        action: "update",
        disruption: "in-place",
        attributes: [{ path: "spec.replicas", before: 3, after: 5 }],
      },
    ]);
  });

  test("without a stack the component is the member", async () => {
    const cap = createKubectlApplyCapability(noApply, () => [deployment()], async () => unchanged());
    expect((await cap.plan!({ env: "prod", component: "api" }, { manifest: "k8s.yaml" })).member).toBe("api");
  });

  test("a manifest equal to the live objects plans as no change", async () => {
    const cap = createKubectlApplyCapability(noApply, () => [deployment()], async () => unchanged());
    const planned = await cap.plan!({ env: "prod", component: "api" }, { manifest: "k8s.yaml", stack: "web" });
    expect(planned.changeSet!.entries.map((e) => e.action)).toEqual(["no-op"]);
  });

  test("creates list the declared fields, a Secret's data marked sensitive, deletes are destroys, a pod-template change rolls", async () => {
    const dryRun: DryRun = {
      fieldManager: "chant:web",
      objects: [
        {
          ref: { apiVersion: "v1", kind: "Secret", name: "s", namespace: "prod" },
          action: "create",
          object: { apiVersion: "v1", kind: "Secret", metadata: { name: "s", namespace: "prod" }, data: { password: "aHVudGVyMg==" } },
          changes: [],
        },
        { ref: web, action: "update", changes: [{ path: "spec.template.spec.containers", before: [{ image: "a" }], after: [{ image: "b" }] }] },
      ],
      deletes: [{ apiVersion: "v1", kind: "ConfigMap", name: "old", namespace: "prod" }],
      retained: [],
    };
    const cap = createKubectlApplyCapability(noApply, () => [], async () => dryRun);
    const { entries } = (await cap.plan!({ env: "prod", component: "api" }, { manifest: "k8s.yaml", stack: "web", delete: "owned-only" })).changeSet!;
    expect(entries[0]).toMatchObject({
      action: "create",
      address: "Secret/prod/s",
      attributes: [{ path: "data.password", sensitive: true }, { path: "metadata.name", after: "s" }, { path: "metadata.namespace", after: "prod" }],
    });
    expect(JSON.stringify(entries)).not.toContain("aHVudGVyMg==");
    expect(entries[1]).toMatchObject({ action: "update", disruption: "rolling" });
    expect(entries[2]).toMatchObject({ action: "delete", disruption: "destroy", address: "ConfigMap/prod/old", type: "v1/ConfigMap" });
  });

  test("an immutable-field refusal is an update with unknown disruption and a hole saying the apply would fail", async () => {
    const cap = createKubectlApplyCapability(noApply, () => [deployment()], async () => ({
      fieldManager: "chant:web",
      objects: [{ ref: web, action: "update", changes: [], refused: "spec.selector: field is immutable" }],
      deletes: [],
      retained: [],
    }));
    const part = (await cap.plan!({ env: "prod", component: "api" }, { manifest: "k8s.yaml", stack: "web" })).changeSet!;
    expect(part.entries[0]).toMatchObject({ action: "update", disruption: "unknown", attributes: [] });
    expect(part.member.holes).toEqual([
      expect.objectContaining({ address: "Deployment/prod/web", reason: expect.stringContaining("field is immutable") }),
    ]);
  });

  test("the digest is stable for the same dry run and moves with what it would change", async () => {
    let to = 5;
    const cap = createKubectlApplyCapability(noApply, () => [deployment()], async () => scaled(to));
    const ctx = { env: "prod", component: "api" };
    const input = { manifest: "k8s.yaml", stack: "web" };
    const a = (await cap.plan!(ctx, input)).planDigest;
    expect((await cap.plan!(ctx, input)).planDigest).toBe(a);
    to = 6;
    expect((await cap.plan!(ctx, input)).planDigest).not.toBe(a);
    to = 5;
    expect((await cap.plan!({ ...ctx, env: "staging" }, input)).planDigest).not.toBe(a);
  });

  test("a live value moving under a field the apply sets to the same value leaves the digest alone", async () => {
    let from = 3;
    const cap = createKubectlApplyCapability(noApply, () => [deployment()], async () => ({
      fieldManager: "chant:web",
      objects: [{ ref: web, action: "update", changes: [{ path: "spec.replicas", before: from, after: 5 }] }],
      deletes: [],
      retained: [],
    }));
    const ctx = { env: "prod", component: "api" };
    const a = (await cap.plan!(ctx, { manifest: "k8s.yaml", stack: "web" })).planDigest;
    from = 4;
    expect((await cap.plan!(ctx, { manifest: "k8s.yaml", stack: "web" })).planDigest).toBe(a);
  });

  test("release attributes are set before the dry run, so the plan covers what run applies", async () => {
    const stampedDeployment = () => ({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "api" },
      spec: {
        template: {
          metadata: {},
          spec: { containers: [{ name: "api", image: "x", env: [{ name: "CHANT_RELEASE_ATTRIBUTES", valueFrom: { fieldRef: { fieldPath: "metadata.annotations['chant.intentius.io/release-attributes']" } } }] }] },
        },
      },
    });
    let planned: Record<string, any>[] = [];
    const cap = createKubectlApplyCapability(noApply, () => [stampedDeployment()], async (args) => {
      planned = args.documents as never;
      return unchanged();
    });
    const result = await cap.plan!({ env: "prod", component: "api", release: { revision: "0123abc" } }, { manifest: "k8s.yaml", stack: "web" });
    expect(planned[0].spec.template.metadata.annotations["chant.intentius.io/release-attributes"]).toContain("0123abc");
    expect((result.artifact as { documents: unknown[] }).documents).toEqual(planned);
  });

  test("run handed the plan applies the planned documents after a fresh dry run agrees", async () => {
    let to = 5;
    const applied: Record<string, unknown>[] = [];
    let reads = 0;
    const cap = createKubectlApplyCapability(
      async (args) => {
        applied.push(args as never);
        return { applied: [web], pruned: [], fieldManager: "chant:web" };
      },
      () => {
        reads++;
        return [deployment()];
      },
      async () => scaled(to),
    );
    const input = { manifest: "k8s.yaml", stack: "web", delete: "owned-only" as const };
    const planned = await cap.plan!({ env: "prod", component: "api" }, input);
    await cap.run({ env: "prod", component: "api", plans: { web: planned.artifact } }, input);
    expect(reads).toBe(1);
    expect(applied).toEqual([{ manifest: "k8s.yaml", documents: [deployment()], environment: "prod", stack: "web", deleteMode: "owned-only" }]);

    to = 7;
    const { KubectlApplyPlanMovedError } = await import("./kubectl-apply");
    const moved = cap.run({ env: "prod", component: "api", plans: { web: planned.artifact } }, input);
    await expect(moved).rejects.toBeInstanceOf(KubectlApplyPlanMovedError);
    await expect(moved).rejects.toMatchObject({ planMoved: true, exitCode: 3, approved: planned.planDigest });
    // Core's mark for a moved plan, so the command that applied it exits 3 (#3997).
    const { isPlanMovedError } = await import("@intentius/chant/components/capability");
    expect(isPlanMovedError(await moved.catch((e: unknown) => e))).toBe(true);
    expect(applied).toHaveLength(1);
  });

  test("a plan for another member is not this step's: run applies as it would without one", async () => {
    const applied: Record<string, unknown>[] = [];
    const cap = createKubectlApplyCapability(
      async (args) => {
        applied.push(args as never);
        return { applied: [], pruned: [], fieldManager: "chant:web" };
      },
      () => [deployment()],
      async () => {
        throw new Error("no dry run expected");
      },
    );
    await cap.run({ env: "prod", component: "api", plans: { other: { kind: "kubectl-apply-plan", planDigest: "sha256:x", documents: [] } } }, { manifest: "k8s.yaml", stack: "web" });
    expect(applied).toEqual([{ manifest: "k8s.yaml", environment: "prod", stack: "web" }]);
  });
});

describe("kubectl-apply outputs: the fields a step names (#3999)", () => {
  type DryRun = import("./kubectl-apply").KubectlApplyDryRun;
  const svcRef = { apiVersion: "v1", kind: "Service", name: "web", namespace: "prod" };
  const service = () => ({ apiVersion: "v1", kind: "Service", metadata: { name: "web", namespace: "prod" }, spec: { type: "LoadBalancer", ports: [{ port: 80 }] } });
  const live = () => ({ ...service(), spec: { ...service().spec, clusterIP: "10.0.0.9" }, status: { loadBalancer: { ingress: [{ hostname: "web.example" }] } } });
  const outputs = {
    host: { object: "Service/prod/web", field: "status.loadBalancer.ingress.0.hostname" },
    port: { object: "Service/prod/web", field: "spec.ports.0.port" },
  };
  const dryRun = (action: "create" | "update" | "no-op"): DryRun => ({ fieldManager: "chant:web", stack: "web", objects: [{ ref: svcRef, action, changes: [] }], deletes: [], retained: [] });
  const ctx = { env: "prod", component: "web" };
  const applied = async () => ({ applied: [], pruned: [], fieldManager: "chant:web" });

  test("outputs reads each named field from the cluster, applying nothing; a step that names none has none", async () => {
    const reads: unknown[] = [];
    const cap = createKubectlApplyCapability(
      async () => {
        throw new Error("applied");
      },
      () => [service()],
      undefined,
      async (args) => {
        reads.push(args);
        return [live()];
      },
    );
    expect(await cap.outputs!(ctx, { manifest: "k8s.yaml", stack: "web", outputs })).toEqual({ host: "web.example", port: 80 });
    expect(reads).toEqual([{ refs: [svcRef], environment: "prod" }]);
    expect(await cap.outputs!(ctx, { manifest: "k8s.yaml", stack: "web" })).toEqual({});
  });

  test("an object not made yet leaves its outputs out", async () => {
    const cap = createKubectlApplyCapability(applied, () => [service()], undefined, async () => [undefined]);
    expect(await cap.outputs!(ctx, { manifest: "k8s.yaml", stack: "web", outputs })).toEqual({});
  });

  test("run returns the named fields as outputs, read once the apply landed, which a dependent's stackOutput() reads", async () => {
    const cap = createKubectlApplyCapability(applied, () => [service()], undefined, async () => [live()]);
    const out = await cap.run(ctx, { manifest: "k8s.yaml", stack: "web", outputs });
    expect(out.outputs).toEqual({ host: "web.example", port: 80 });
  });

  test("an output naming an object the manifest does not declare is an error that says what it declares", async () => {
    const cap = createKubectlApplyCapability(applied, () => [service()], undefined, async () => [live()]);
    await expect(cap.outputs!(ctx, { manifest: "k8s.yaml", stack: "web", outputs: { x: { object: "Service/prod/api", field: "spec" } } })).rejects.toThrow(
      'kubectl-apply "web": output "x" names Service/prod/api, which k8s.yaml does not declare (it declares Service/prod/web)',
    );
  });

  test("a plan knows a field the manifest sets; a field the server fills is known only after apply", async () => {
    const cap = createKubectlApplyCapability(applied, () => [service()], async () => dryRun("create"), async () => {
      throw new Error("a created object has nothing live to read");
    });
    const planned = await cap.plan!(ctx, { manifest: "k8s.yaml", stack: "web", outputs });
    expect(planned.outputs).toEqual({ known: { port: 80 }, unknown: ["host"] });
  });

  test("a plan that leaves the object as it is knows every named field, as the cluster holds it", async () => {
    const cap = createKubectlApplyCapability(applied, () => [service()], async () => dryRun("no-op"), async () => [live()]);
    const planned = await cap.plan!(ctx, { manifest: "k8s.yaml", stack: "web", outputs });
    expect(planned.outputs).toEqual({ known: { host: "web.example", port: 80 }, unknown: [] });
  });

  test("a step that names no outputs plans none", async () => {
    const cap = createKubectlApplyCapability(applied, () => [service()], async () => dryRun("update"));
    expect((await cap.plan!(ctx, { manifest: "k8s.yaml", stack: "web" })).outputs).toBeUndefined();
  });
});

describe("kubectl-apply targets: one object at a time (#4300)", () => {
  type DryRun = import("./kubectl-apply").KubectlApplyDryRun;
  const doc = (kind: string, name: string, namespace?: string) => ({
    apiVersion: kind === "Deployment" ? "apps/v1" : "v1",
    kind,
    metadata: { name, ...(namespace ? { namespace } : {}) },
  });
  const docs = () => [doc("Deployment", "web", "prod"), doc("Service", "web", "prod"), doc("Namespace", "prod")];
  const none = (): DryRun => ({ fieldManager: "chant:web", stack: "web", objects: [], deletes: [], retained: [] });
  const noApply = async (): Promise<never> => {
    throw new Error("applied");
  };

  test("accepts targets", () => {
    expect(createKubectlApplyCapability().targets).toBe("accept");
  });

  test("plans the targeted objects alone, with no prune, and gives the targets back", async () => {
    let seen: Record<string, unknown> = {};
    const cap = createKubectlApplyCapability(noApply, docs, async (args) => {
      seen = args as never;
      return none();
    });
    const ctx = { env: "prod", component: "api", targets: ["Namespace/prod", "Service/prod/web"] };
    const planned = await cap.plan!(ctx, { manifest: "k8s.yaml", stack: "web", delete: "owned-only" });
    expect(seen).toMatchObject({ documents: [doc("Service", "web", "prod"), doc("Namespace", "prod")], deleteMode: "never" });
    expect(planned.targets).toEqual(["Namespace/prod", "Service/prod/web"]);
    const whole = await cap.plan!({ env: "prod", component: "api" }, { manifest: "k8s.yaml", stack: "web", delete: "owned-only" });
    expect(whole.planDigest).not.toBe(planned.planDigest);
  });

  test("a target the manifest does not declare refuses and names what it declares", async () => {
    const cap = createKubectlApplyCapability(noApply, docs, async () => none());
    await expect(cap.plan!({ env: "prod", component: "api", targets: ["Deployment/prod/api"] }, { manifest: "k8s.yaml" })).rejects.toThrow(
      /--target Deployment\/prod\/api names no object k8s\.yaml declares \(it declares Deployment\/prod\/web, Service\/prod\/web, Namespace\/prod\)/,
    );
  });

  test("run without a plan applies the targeted objects alone, with no prune", async () => {
    let seen: Record<string, unknown> = {};
    const cap = createKubectlApplyCapability(async (args) => {
      seen = args as never;
      return { fieldManager: "chant:web", applied: [], pruned: [] };
    }, docs);
    await cap.run({ env: "prod", component: "api", targets: ["Deployment/prod/web"] }, { manifest: "k8s.yaml", stack: "web", delete: "owned-only" });
    expect(seen).toMatchObject({ documents: [doc("Deployment", "web", "prod")], deleteMode: "never" });
  });
});
