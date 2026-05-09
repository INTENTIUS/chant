import { describe, test, expect, vi, beforeEach } from "vitest";
import { createMockPlugin, staticDescribeResources } from "@intentius/chant-test-utils";
import type { BuildResult } from "../build";

const writeSnapshotMock = vi.fn();
const getHeadCommitMock = vi.fn();
const pushStateMock = vi.fn();

vi.mock("./git", () => ({
  writeSnapshot: (...args: unknown[]) => writeSnapshotMock(...args),
  getHeadCommit: () => getHeadCommitMock(),
  pushState: () => pushStateMock(),
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
    pushStateMock.mockReset();
    writeSnapshotMock.mockResolvedValue("commit-sha");
    getHeadCommitMock.mockResolvedValue("head-sha");
    pushStateMock.mockResolvedValue(true);
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
    expect(pushStateMock).toHaveBeenCalledTimes(1);
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
});
