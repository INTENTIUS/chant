import { describe, test, expect, vi, beforeEach } from "vitest";
import { createMockPlugin, staticDescribeResources, staticObservation, staticListArtifacts } from "@intentius/chant-test-utils";
import type { BuildResult } from "../build";

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
