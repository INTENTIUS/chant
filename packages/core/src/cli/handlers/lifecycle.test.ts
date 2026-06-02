import { describe, test, expect, vi, beforeEach } from "vitest";
import { createMockPlugin, staticDescribeResources, staticListArtifacts } from "@intentius/chant-test-utils";
import type { LexiconPlugin, ResourceMetadata } from "../../lexicon";
import type { BuildResult } from "../../build";
import type { ParsedArgs } from "../registry";

const buildMock = vi.fn();
const fetchLifecycleMock = vi.fn();
const readSnapshotMock = vi.fn();
const readEnvironmentSnapshotsMock = vi.fn();
const listSnapshotsMock = vi.fn();
const takeSnapshotMock = vi.fn();
const loadChantConfigMock = vi.fn();

vi.mock("../../build", () => ({ build: (...args: unknown[]) => buildMock(...args) }));
vi.mock("../../lifecycle/git", () => ({
  fetchLifecycle: () => fetchLifecycleMock(),
  readSnapshot: (...args: unknown[]) => readSnapshotMock(...args),
  readEnvironmentSnapshots: (...args: unknown[]) => readEnvironmentSnapshotsMock(...args),
  listSnapshots: (...args: unknown[]) => listSnapshotsMock(...args),
}));
vi.mock("../../lifecycle/snapshot", () => ({
  takeSnapshot: (...args: unknown[]) => takeSnapshotMock(...args),
}));
vi.mock("../../config", () => ({
  loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args),
}));

const { runLifecycleDiff, runLifecycleSnapshot, runLifecycleShow, runLifecycleLog, runLifecycleUnknown } = await import("./lifecycle");

function makeArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    command: "state",
    path: "diff",
    format: "",
    fix: false,
    watch: false,
    verbose: false,
    help: false,
    live: false,
    ...overrides,
  };
}

function makeBuildResult(entitiesByLexicon: Record<string, string[]>): BuildResult {
  const entities = new Map();
  for (const [lexicon, names] of Object.entries(entitiesByLexicon)) {
    for (const name of names) {
      entities.set(name, { lexicon, entityType: `${lexicon}::Mock`, props: {} });
    }
  }
  return {
    outputs: new Map(Object.keys(entitiesByLexicon).map((l) => [l, "{}"])),
    entities,
    dependencies: new Map(),
    errors: [],
    warnings: [],
    manifest: {
      lexicons: Object.keys(entitiesByLexicon),
      outputs: {},
      deployOrder: Object.keys(entitiesByLexicon),
    },
    sourceFileCount: 1,
  } as unknown as BuildResult;
}

const meta = (overrides: Partial<ResourceMetadata> = {}): ResourceMetadata => ({
  type: "AWS::S3::Bucket",
  status: "CREATE_COMPLETE",
  physicalId: "bucket-1",
  ...overrides,
});

describe("runLifecycleDiff --live", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    stdoutSpy = vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    stderrSpy = vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    buildMock.mockReset();
    fetchLifecycleMock.mockReset();
    readSnapshotMock.mockReset();
  });

  test("surfaces drift between previous snapshot and live state", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(JSON.stringify({
      lexicon: "aws",
      environment: "prod",
      commit: "abc",
      timestamp: "2026-04-01T00:00:00Z",
      resources: { bucket: meta({ status: "CREATE_COMPLETE" }) },
    }));

    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "aws",
        describeResources: staticDescribeResources({
          bucket: meta({ status: "UPDATE_COMPLETE" }),
        }),
      }),
    ];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runLifecycleDiff(ctx);

    expect(exit).toBe(0);
    const output = stdoutBuf.join("\n");
    expect(output).toContain("DRIFTED");
    expect(output).toContain("bucket");
    expect(output).toContain("status:");
    expect(output).toContain("CREATE_COMPLETE");
    expect(output).toContain("UPDATE_COMPLETE");
  });

  test("warns and skips lexicons without describeResources", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ k8s: ["pod"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);

    const plugins: LexiconPlugin[] = [
      createMockPlugin({ name: "k8s" }),
    ];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runLifecycleDiff(ctx);

    expect(exit).toBe(1);
    const stderr = stderrBuf.join("\n");
    expect(stderr).toContain("k8s");
    expect(stderr).toContain("does not implement describeResources");
  });

  test("--live with a listArtifacts-only plugin diffs artifacts (no resources path)", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ helm: [] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    // Previous snapshot has no artifact entry for the new release → expect ARTIFACTS ADDED
    readSnapshotMock.mockResolvedValue(JSON.stringify({
      lexicon: "helm",
      environment: "prod",
      commit: "x",
      timestamp: "t",
      resources: {},
      artifacts: {},
    }));

    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "helm",
        listArtifacts: staticListArtifacts({
          "release/default/web": { type: "Helm::Release", physicalId: "default/web", status: "deployed" },
        }),
      }),
    ];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runLifecycleDiff(ctx);

    expect(exit).toBe(0);
    const output = stdoutBuf.join("\n");
    expect(output).toContain("ARTIFACTS ADDED");
    expect(output).toContain("release/default/web");
  });

  test("legacy digest mode still works without --live", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);

    const plugins: LexiconPlugin[] = [createMockPlugin({ name: "aws" })];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: false }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runLifecycleDiff(ctx);

    expect(exit).toBe(0);
    const output = stdoutBuf.join("\n");
    expect(output).toContain("aws");
    expect(output).toContain("bucket");
    expect(output).toContain("added");
  });
});

describe("runLifecycleSnapshot", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    buildMock.mockReset();
    takeSnapshotMock.mockReset();
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: { environments: ["prod"] } });
  });

  test("missing environment arg → exit 1 with helpful message", async () => {
    const ctx = {
      args: makeArgs({ command: "state", path: "snapshot" }),
      plugins: [],
      serializers: [],
    };
    const exit = await runLifecycleSnapshot(ctx);
    expect(exit).toBe(1);
    expect(stderrBuf.join("\n")).toContain("Environment is required");
  });

  test("environment not in config → exit 1", async () => {
    const ctx = {
      args: makeArgs({ command: "state", path: "snapshot", extraPositional: "unknown" }),
      plugins: [],
      serializers: [],
    };
    const exit = await runLifecycleSnapshot(ctx);
    expect(exit).toBe(1);
    expect(stderrBuf.join("\n")).toContain('Unknown environment "unknown"');
  });

  test("no plugins implement describeResources → exit 1 with hint", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["x"] }));
    const plugins: LexiconPlugin[] = [createMockPlugin({ name: "aws" })];
    const ctx = {
      args: makeArgs({ command: "state", path: "snapshot", extraPositional: "prod" }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };
    const exit = await runLifecycleSnapshot(ctx);
    expect(exit).toBe(1);
    expect(stderrBuf.join("\n")).toContain("No plugins implement describeResources");
  });

  test("happy path: writes snapshot via takeSnapshot and reports counts", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    takeSnapshotMock.mockResolvedValue({
      snapshots: [{ lexicon: "aws", environment: "prod", resources: { bucket: meta() } }],
      commit: "sha",
      warnings: [],
      errors: [],
    });
    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "aws",
        describeResources: staticDescribeResources({ bucket: meta() }),
      }),
    ];
    const ctx = {
      args: makeArgs({ command: "state", path: "snapshot", extraPositional: "prod" }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };
    const exit = await runLifecycleSnapshot(ctx);
    expect(exit).toBe(0);
    expect(stderrBuf.join("\n")).toContain("Snapshot saved");
    expect(takeSnapshotMock).toHaveBeenCalledTimes(1);
  });
});

describe("runLifecycleShow", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    fetchLifecycleMock.mockReset();
    readSnapshotMock.mockReset();
    readEnvironmentSnapshotsMock.mockReset();
  });

  test("missing environment arg → exit 1", async () => {
    const ctx = {
      args: makeArgs({ command: "state", path: "show" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleShow(ctx)).toBe(1);
    expect(stderrBuf.join("\n")).toContain("Environment is required");
  });

  test("specific lexicon: prints snapshot table when found", async () => {
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(JSON.stringify({
      lexicon: "aws", environment: "prod", commit: "x", timestamp: "t",
      resources: { bucket: { type: "AWS::S3::Bucket", physicalId: "b-1", status: "OK" } },
    }));
    const ctx = {
      args: makeArgs({ command: "state", path: "show", extraPositional: "prod", extraPositional2: "aws" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleShow(ctx)).toBe(0);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("bucket");
    expect(out).toContain("AWS::S3::Bucket");
  });

  test("specific lexicon: returns 1 when no snapshot found", async () => {
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);
    const ctx = {
      args: makeArgs({ command: "state", path: "show", extraPositional: "prod", extraPositional2: "aws" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleShow(ctx)).toBe(1);
    expect(stderrBuf.join("\n")).toContain("No snapshot found");
  });

  test("no lexicon: lists all lexicons in env", async () => {
    fetchLifecycleMock.mockResolvedValue(undefined);
    readEnvironmentSnapshotsMock.mockResolvedValue(new Map([
      ["aws", JSON.stringify({ lexicon: "aws", environment: "prod", commit: "x", timestamp: "t", resources: {} })],
      ["gcp", JSON.stringify({ lexicon: "gcp", environment: "prod", commit: "x", timestamp: "t", resources: {} })],
    ]));
    const ctx = {
      args: makeArgs({ command: "state", path: "show", extraPositional: "prod" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleShow(ctx)).toBe(0);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("prod/aws");
    expect(out).toContain("prod/gcp");
  });
});

describe("runLifecycleLog", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    fetchLifecycleMock.mockReset();
    listSnapshotsMock.mockReset();
  });

  test("returns 1 with message when no entries exist", async () => {
    fetchLifecycleMock.mockResolvedValue(undefined);
    listSnapshotsMock.mockResolvedValue([]);
    const ctx = {
      args: makeArgs({ command: "state", path: "log" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleLog(ctx)).toBe(1);
    expect(stderrBuf.join("\n")).toContain("No state snapshots");
  });

  test("prints commit / date / message rows for each entry", async () => {
    fetchLifecycleMock.mockResolvedValue(undefined);
    listSnapshotsMock.mockResolvedValue([
      { commit: "abcdef1234567890", date: "2026-05-01T00:00:00Z", message: "Snapshot prod" },
      { commit: "fedcba9876543210", date: "2026-05-02T00:00:00Z", message: "Snapshot staging" },
    ]);
    const ctx = {
      args: makeArgs({ command: "state", path: "log" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleLog(ctx)).toBe(0);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("abcdef1");
    expect(out).toContain("Snapshot prod");
    expect(out).toContain("Snapshot staging");
  });
});

describe("runLifecycleUnknown", () => {
  test("returns 1 with subcommand list", async () => {
    const stderrBuf: string[] = [];
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    const ctx = {
      args: makeArgs({ command: "state", path: "garbage" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleUnknown(ctx)).toBe(1);
    const stderr = stderrBuf.join("\n");
    expect(stderr).toContain("snapshot");
    expect(stderr).toContain("show");
    expect(stderr).toContain("diff");
    expect(stderr).toContain("log");
  });
});
