import { describe, test, expect, vi, beforeEach } from "vitest";
import { createMockPlugin, staticDescribeResources } from "@intentius/chant-test-utils";
import type { LexiconPlugin, ResourceMetadata } from "../../lexicon";
import type { BuildResult } from "../../build";
import type { ParsedArgs } from "../registry";

const buildMock = vi.fn();
const fetchStateMock = vi.fn();
const readSnapshotMock = vi.fn();

vi.mock("../../build", () => ({ build: (...args: unknown[]) => buildMock(...args) }));
vi.mock("../../state/git", () => ({
  fetchState: () => fetchStateMock(),
  readSnapshot: (...args: unknown[]) => readSnapshotMock(...args),
  readEnvironmentSnapshots: vi.fn(),
  listSnapshots: vi.fn(),
}));

const { runStateDiff } = await import("./state");

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

describe("runStateDiff --live", () => {
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
    fetchStateMock.mockReset();
    readSnapshotMock.mockReset();
  });

  test("surfaces drift between previous snapshot and live state", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchStateMock.mockResolvedValue(undefined);
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

    const exit = await runStateDiff(ctx);

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
    fetchStateMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);

    const plugins: LexiconPlugin[] = [
      createMockPlugin({ name: "k8s" }),
    ];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runStateDiff(ctx);

    expect(exit).toBe(1);
    const stderr = stderrBuf.join("\n");
    expect(stderr).toContain("k8s");
    expect(stderr).toContain("does not implement describeResources");
  });

  test("legacy digest mode still works without --live", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchStateMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);

    const plugins: LexiconPlugin[] = [createMockPlugin({ name: "aws" })];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: false }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runStateDiff(ctx);

    expect(exit).toBe(0);
    const output = stdoutBuf.join("\n");
    expect(output).toContain("aws");
    expect(output).toContain("bucket");
    expect(output).toContain("added");
  });
});
