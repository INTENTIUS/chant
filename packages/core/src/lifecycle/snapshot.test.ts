import { describe, test, expect, vi, beforeEach } from "vitest";
import { createMockPlugin, staticDescribeResources, staticObservation, staticListArtifacts } from "@intentius/chant-test-utils";
import type { BuildResult } from "../build";
import type { DeepResourceObservation } from "../deep-observation";
import type { UnobservedEntity } from "../observation";

const writeSnapshotMock = vi.fn();
const getHeadCommitMock = vi.fn();
const pushLifecycleMock = vi.fn();

vi.mock("./git", () => ({
  writeSnapshot: (...args: unknown[]) => writeSnapshotMock(...args),
  snapshotStorageKey: (lexicon: string, stack?: string) => (stack ? `${stack}__${lexicon}` : lexicon),
  getHeadCommit: () => getHeadCommitMock(),
  pushLifecycle: () => pushLifecycleMock(),
}));

const { takeSnapshot } = await import("./snapshot");

function makeBuildResult(entitiesByLexicon: Record<string, string[]>): BuildResult {
  const entities = new Map();
  for (const [lexicon, names] of Object.entries(entitiesByLexicon)) {
    for (const name of names) entities.set(name, { lexicon, entityType: `${lexicon}::Mock`, props: {} });
  }
  return {
    outputs: new Map(Object.keys(entitiesByLexicon).map((l) => [l, "{}"])),
    entities,
    dependencies: new Map(),
    errors: [],
    warnings: [],
    manifest: { lexicons: Object.keys(entitiesByLexicon), outputs: {}, deployOrder: [] },
    sourceFileCount: 1,
  } as unknown as BuildResult;
}

describe("takeSnapshot", () => {
  beforeEach(() => {
    writeSnapshotMock.mockReset();
    getHeadCommitMock.mockReset();
    pushLifecycleMock.mockReset();
    writeSnapshotMock.mockResolvedValue("commit-sha");
    getHeadCommitMock.mockResolvedValue("head-sha");
    pushLifecycleMock.mockResolvedValue(true);
  });

  test("happy path: writes snapshot per plugin with describeResources", async () => {
    const plugin = createMockPlugin({
      name: "aws",
      describeResources: staticDescribeResources({
        bucket: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE", physicalId: "bucket-1" },
      }),
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["bucket"] }));
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      lexicon: "aws",
      environment: "prod",
      commit: "head-sha",
      resources: { bucket: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE" } },
    });
    expect(writeSnapshotMock).toHaveBeenCalledTimes(1);
    expect(pushLifecycleMock).toHaveBeenCalledTimes(1);
    // Single-stack: written under the bare lexicon key, snapshot carries no stack.
    expect(writeSnapshotMock.mock.calls[0][1]).toBe("aws");
    expect(result.snapshots[0].stack).toBeUndefined();
  });

  // #932 — a multi-stack project observes each stack against its own live stack
  // and stores its snapshot under a stack-scoped key so siblings don't overwrite.
  test("stack option: observes the named stack and stores under a stack-scoped key", async () => {
    let observedStack: string | undefined = "unset";
    const plugin = createMockPlugin({
      name: "aws",
      describeResources: async (options: { stack?: string }) => {
        observedStack = options.stack;
        return { bucket: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE", physicalId: "b" } };
      },
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["bucket"] }), { stack: "loom-backend" });
    // describeResources was told which live stack to query.
    expect(observedStack).toBe("loom-backend");
    // The snapshot records its stack …
    expect(result.snapshots[0].stack).toBe("loom-backend");
    // … and is stored under `<stack>__<lexicon>`, not the bare lexicon key.
    expect(writeSnapshotMock.mock.calls[0][1]).toBe("loom-backend__aws");
  });

  test("region option: the stack's own region reaches describeResources (#1261)", async () => {
    let observedRegion: string | undefined = "unset";
    const plugin = createMockPlugin({
      name: "aws",
      describeResources: async (options: { region?: string }) => {
        observedRegion = options.region;
        return { bucket: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE", physicalId: "b" } };
      },
    });
    await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["bucket"] }), {
      stack: "loom-us-west-2",
      region: "us-west-2",
    });
    // Without this the reader falls back to the ambient region, and every stack
    // outside it snapshots as "no valid resources or artifacts returned".
    expect(observedRegion).toBe("us-west-2");
  });

  test("no region declared: describeResources keeps its ambient-region default", async () => {
    let observedRegion: string | undefined = "unset";
    const plugin = createMockPlugin({
      name: "aws",
      describeResources: async (options: { region?: string }) => {
        observedRegion = options.region;
        return { bucket: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE", physicalId: "b" } };
      },
    });
    await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["bucket"] }));
    expect(observedRegion).toBeUndefined();
  });

  // #1267 — a snapshot records identity by default; --deep also records each
  // resource's property tree, which is what a fold over topology needs.
  describe("deep snapshots (#1267)", () => {
    const identity = { bucket: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE", physicalId: "b" } };

    function deepPlugin(
      resources: Record<string, DeepResourceObservation>,
      unobserved: Record<string, UnobservedEntity> = {},
    ) {
      return createMockPlugin({
        name: "aws",
        describeResources: staticDescribeResources(identity),
        observeResourcesDeep: async () => ({ deepObservation: "v1" as const, resources, unobserved }),
      });
    }

    test("without --deep: identity only, and depth is not written", async () => {
      const plugin = deepPlugin({
        bucket: { type: "AWS::S3::Bucket", physicalId: "b", properties: { versioning: "Enabled" } },
      });
      const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["bucket"] }));
      // Absent, not "identity" — every snapshot written before #1267 is thin,
      // and a reader must treat a missing field as thin rather than unknown.
      expect(result.snapshots[0].depth).toBeUndefined();
      expect(result.snapshots[0].properties).toBeUndefined();
    });

    test("with --deep: records the property trees alongside identity", async () => {
      const plugin = deepPlugin({
        bucket: { type: "AWS::S3::Bucket", physicalId: "b", properties: { versioning: "Enabled" } },
      });
      const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["bucket"] }), { deep: true });
      expect(result.snapshots[0].depth).toBe("deep");
      expect(result.snapshots[0].properties?.bucket.properties).toEqual({ versioning: "Enabled" });
      // Identity is still there — deep adds, it does not replace.
      expect(result.snapshots[0].resources.bucket).toMatchObject({ type: "AWS::S3::Bucket" });
    });

    test("--deep against a lexicon with no deep reader: identity snapshot plus a warning", async () => {
      const plugin = createMockPlugin({ name: "aws", describeResources: staticDescribeResources(identity) });
      const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["bucket"] }), { deep: true });
      // Still a usable snapshot, but it must not claim a depth it does not have.
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0].depth).toBeUndefined();
      expect(result.warnings.join("\n")).toContain("no deep reader");
    });

    test("--deep returning nothing: downgrades to identity rather than discarding a good snapshot", async () => {
      const plugin = deepPlugin({});
      const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["bucket"] }), { deep: true });
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0].depth).toBeUndefined();
      expect(result.warnings.join("\n")).toContain("deep read returned no properties");
    });

    test("--deep passes the stack's region to the deep reader (#1261 family)", async () => {
      let seen: string | undefined = "unset";
      const plugin = createMockPlugin({
        name: "aws",
        describeResources: staticDescribeResources(identity),
        observeResourcesDeep: async (options: { region?: string }) => {
          seen = options.region;
          return {
            deepObservation: "v1" as const,
            resources: { bucket: { type: "AWS::S3::Bucket", physicalId: "b", properties: {} } },
            unobserved: {},
          };
        },
      });
      await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["bucket"] }), {
        stack: "app-us-west-2",
        region: "us-west-2",
        deep: true,
      });
      // Without this the deep read targets the ambient region and comes back
      // empty, which downgrades a multi-region snapshot to identity silently.
      expect(seen).toBe("us-west-2");
    });

    test("--deep reports entities the deep reader could not read", async () => {
      const plugin = deepPlugin(
        { bucket: { type: "AWS::S3::Bucket", physicalId: "b", properties: {} } },
        { queue: { reason: "read-failed", detail: "boom" } },
      );
      const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["bucket"] }), { deep: true });
      expect(result.warnings.join("\n")).toContain("not observed deeply");
    });
  });

  test("plugin without describeResources is skipped", async () => {
    const plugin = createMockPlugin({ name: "aws" });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["x"] }));
    expect(result.snapshots).toEqual([]);
    expect(writeSnapshotMock).not.toHaveBeenCalled();
  });

  test("plugin throws → captured as error, other plugins still proceed", async () => {
    const broken = createMockPlugin({
      name: "broken",
      describeResources: async () => { throw new Error("boom"); },
    });
    const ok = createMockPlugin({
      name: "ok",
      describeResources: staticDescribeResources({ x: { type: "T", status: "OK" } }),
    });
    const result = await takeSnapshot("prod", [broken, ok], makeBuildResult({ broken: ["b"], ok: ["x"] }));
    expect(result.errors.some((e) => e.includes("broken") && e.includes("boom"))).toBe(true);
    expect(result.snapshots.map((s) => s.lexicon)).toEqual(["ok"]);
  });

  test("plugin returns no valid resources → error and no snapshot", async () => {
    const plugin = createMockPlugin({
      name: "aws",
      describeResources: async () => ({}), // empty
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: [] }));
    expect(result.snapshots).toEqual([]);
    expect(result.errors.some((e) => e.includes("aws") && e.includes("no valid"))).toBe(true);
  });

  // #1089 — a snapshot is evidence of what was seen. An entity nobody could
  // read must be recorded as a hole, not omitted (which the next diff would
  // read back as "was not there").
  test("records unobserved entities alongside the resources", async () => {
    const plugin = createMockPlugin({
      name: "k8s",
      describeResources: staticObservation(
        { web: { type: "K8s::Apps::Deployment", status: "READY" } },
        { widget: { type: "K8s::X::Widget", reason: "unsupported-kind", detail: "no reader" } },
      ),
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ k8s: ["web", "widget"] }));
    expect(result.snapshots[0].unobserved).toEqual({
      widget: { type: "K8s::X::Widget", reason: "unsupported-kind", detail: "no reader" },
    });
    expect(result.warnings.some((w) => w.includes("widget") && w.includes("not observed"))).toBe(true);
  });

  test("an entirely unreadable environment is not snapshotted as empty", async () => {
    const plugin = createMockPlugin({
      name: "k8s",
      describeResources: staticObservation({}, { web: { reason: "no-credentials" } }),
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ k8s: ["web"] }));
    expect(result.snapshots).toEqual([]);
    expect(result.errors.some((e) => e.includes("could not be read"))).toBe(true);
  });

  test("a throwing plugin reports each declared entity as unobserved in the warnings", async () => {
    const plugin = createMockPlugin({
      name: "k8s",
      describeResources: async () => { throw new Error("kubeconfig missing"); },
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ k8s: ["web"] }));
    expect(result.snapshots).toEqual([]);
    expect(result.warnings.some((w) => w.includes("web") && w.includes("kubeconfig missing"))).toBe(true);
  });

  test("resources missing required type/status are dropped with warning", async () => {
    const plugin = createMockPlugin({
      name: "aws",
      describeResources: staticDescribeResources({
        valid:   { type: "T", status: "OK" },
        bad:     { type: "", status: "OK" } as never,
      }),
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["valid"] }));
    expect(result.snapshots[0].resources).toEqual({ valid: { type: "T", status: "OK" } });
    expect(result.warnings.some((w) => w.includes("Dropped bad"))).toBe(true);
  });

  test("emits sensitive-data warnings for suspect attribute names", async () => {
    const plugin = createMockPlugin({
      name: "aws",
      describeResources: staticDescribeResources({
        cred: {
          type: "T",
          status: "OK",
          attributes: { connectionString: "redacted", regularAttr: "x" },
        },
      }),
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["cred"] }));
    expect(result.warnings.some((w) => w.toLowerCase().includes("sensitive"))).toBe(true);
  });

  // ── listArtifacts() integration (#51) ─────────────────────────────────────

  test("calls listArtifacts when implemented and stores artifacts in snapshot", async () => {
    const plugin = createMockPlugin({
      name: "helm",
      listArtifacts: staticListArtifacts({
        "release/default/web": { type: "Helm::Release", physicalId: "default/web", status: "deployed" },
      }),
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ helm: [] }));
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].artifacts).toEqual({
      "release/default/web": { type: "Helm::Release", physicalId: "default/web", status: "deployed" },
    });
    expect(result.snapshots[0].resources).toEqual({});
  });

  test("plugin can implement both describeResources and listArtifacts", async () => {
    const plugin = createMockPlugin({
      name: "k8s",
      describeResources: staticDescribeResources({
        web: { type: "K8s::Apps::Deployment", status: "READY" },
      }),
      listArtifacts: staticListArtifacts({
        "release/default/proxy": { type: "Helm::Release", status: "deployed" },
      }),
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ k8s: ["web"] }));
    expect(result.snapshots[0].resources).toEqual({
      web: { type: "K8s::Apps::Deployment", status: "READY" },
    });
    expect(result.snapshots[0].artifacts).toBeDefined();
    expect(result.snapshots[0].artifacts!["release/default/proxy"]).toBeDefined();
  });

  test("plugin with neither method is skipped (existing behavior preserved)", async () => {
    const plugin = createMockPlugin({ name: "noop" });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ noop: ["x"] }));
    expect(result.snapshots).toEqual([]);
  });

  test("listArtifacts only, empty result → error 'no valid resources or artifacts returned'", async () => {
    const plugin = createMockPlugin({
      name: "helm",
      listArtifacts: async () => ({}),
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ helm: [] }));
    expect(result.errors.some((e) => e.includes("helm") && e.includes("no valid"))).toBe(true);
    expect(result.snapshots).toEqual([]);
  });
});

// #1266 — a snapshot that records only what it manages cannot answer a fold
// question when it is replayed: the account's default VPC routing is not in it,
// so `internetFacing` is unanswerable and `search --at` would be quietly weaker
// than `search --live`.
describe("dependencies and edges in a snapshot (#1266)", () => {
  const identity = { webServer: { type: "AWS::EC2::Instance", status: "OK", physicalId: "i-1" } };

  test("records the dependencies the estate references, and the edges to them", async () => {
    const plugin = createMockPlugin({
      name: "aws",
      describeResources: staticDescribeResources(identity),
      observeDependencies: async () => ({
        resources: {
          "rtb-default": {
            type: "AWS::EC2::RouteTable",
            status: "OBSERVED",
            physicalId: "rtb-default",
            referencedBy: ["webServer"],
          },
        },
        edges: [{ from: "webServer", to: "rtb-default", kind: "ref" as const, viaAttr: "RouteTableId" }],
      }),
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["webServer"] }));
    // Both, in one record: what exists and how it connects.
    expect(result.snapshots[0].resources["rtb-default"]).toMatchObject({ referencedBy: ["webServer"] });
    expect(result.snapshots[0].edges).toEqual([
      { from: "webServer", to: "rtb-default", kind: "ref", viaAttr: "RouteTableId" },
    ]);
  });

  test("a lexicon with no dependency reader snapshots exactly as before", async () => {
    const plugin = createMockPlugin({ name: "aws", describeResources: staticDescribeResources(identity) });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["webServer"] }));
    expect(Object.keys(result.snapshots[0].resources)).toEqual(["webServer"]);
    // Absent, not empty — "no relationships recorded", not "none existed".
    expect(result.snapshots[0].edges).toBeUndefined();
  });

  test("a dependency read that fails warns and keeps the managed snapshot", async () => {
    const plugin = createMockPlugin({
      name: "aws",
      describeResources: staticDescribeResources(identity),
      observeDependencies: async () => {
        throw new Error("route tables unreadable");
      },
    });
    const result = await takeSnapshot("prod", [plugin], makeBuildResult({ aws: ["webServer"] }));
    // The managed observation is complete and useful on its own; losing it
    // because an ambient dependency could not be read trades a whole answer
    // for none.
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].resources.webServer).toBeDefined();
    expect(result.warnings.join("\n")).toContain("dependencies not read");
  });
});
