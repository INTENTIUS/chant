import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ParsedArgs } from "../registry";
import { DECLARABLE_MARKER, type Declarable } from "../../declarable";
import { createMockPlugin } from "../../../../test-utils/src/mock-plugin";

// #1268 — query-scoped drift: `chant search --at latest --check-live` (and its
// reverse, `--live --check-snapshot`) compares the matched rows against the
// observation the primary answer did NOT use, reusing `diffLive` — the same
// engine `lifecycle diff --live` uses — scoped to just those rows.

const discoverMock = vi.fn();
vi.mock("../../discovery/index", () => ({
  discover: (...a: unknown[]) => discoverMock(...a),
}));
const loadPluginsMock = vi.fn();
const resolveLexMock = vi.fn();
vi.mock("../plugins", async () => {
  const actual = await vi.importActual<typeof import("../plugins")>("../plugins");
  return {
    ...actual,
    loadPlugins: (...a: unknown[]) => loadPluginsMock(...a),
    resolveProjectLexicons: (...a: unknown[]) => resolveLexMock(...a),
  };
});
const replaySnapshotsMock = vi.fn();
const hasSnapshotMock = vi.fn((..._a: unknown[]) => Promise.resolve(false));
vi.mock("../../lifecycle/replay", () => ({
  replaySnapshots: (...a: unknown[]) => replaySnapshotsMock(...a),
  hasSnapshot: (...a: unknown[]) => hasSnapshotMock(...a),
}));
const loadChantConfigMock = vi.fn();
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: (...a: unknown[]) => loadChantConfigMock(...a) };
});
const buildResultMock = vi.fn();
vi.mock("../../build", async () => {
  const actual = await vi.importActual<typeof import("../../build")>("../../build");
  return {
    ...actual,
    build: (...a: unknown[]) => Promise.resolve(buildResultMock(...a)),
    buildProject: (...a: unknown[]) => Promise.resolve(buildResultMock(...a)),
  };
});

const { runSearch } = await import("./search");

function decl<T extends object>(base: T): Declarable & T {
  return { [DECLARABLE_MARKER]: true, ...base } as Declarable & T;
}

const entities = new Map<string, Declarable>([
  ["webServer", decl({ lexicon: "aws", entityType: "AWS::EC2::Instance", props: {} })],
  ["launchTemplateServer", decl({ lexicon: "aws", entityType: "AWS::EC2::Instance", props: {} })],
  ["dbServer", decl({ lexicon: "aws", entityType: "AWS::RDS::Instance", props: {} })],
]);

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "search", path: "kind:Instance",
    format: "", fix: false, watch: false, verbose: false, help: false, live: false, env: "dev",
    ...overrides,
  };
}

describe("search query-scoped drift (#1268)", () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { err.push(s); });
    discoverMock.mockReset();
    discoverMock.mockResolvedValue({ entities, errors: [], sourceFiles: [] });
    buildResultMock.mockReset();
    buildResultMock.mockReturnValue({ errors: [], entities, outputs: new Map([["aws", ""]]), warnings: [] });
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveLexMock.mockReset();
    resolveLexMock.mockResolvedValue(["aws"]);
    hasSnapshotMock.mockReset();
    hasSnapshotMock.mockResolvedValue(false);
    replaySnapshotsMock.mockReset();
  });

  test("--check-live without --at is refused", async () => {
    const exit = await runSearch({ args: makeArgs({ checkLive: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(err.join("\n")).toContain("--check-live needs --at");
  });

  test("--check-snapshot without --live is refused", async () => {
    const exit = await runSearch({ args: makeArgs({ checkSnapshot: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(err.join("\n")).toContain("--check-snapshot needs --live");
  });

  test("--fail-on-drift without a check flag is refused", async () => {
    const exit = await runSearch({ args: makeArgs({ failOnDrift: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(err.join("\n")).toContain("--fail-on-drift needs --check-live or --check-snapshot");
  });

  test("--at --check-live: drift only for matched rows, using diffLive's categories", async () => {
    replaySnapshotsMock.mockResolvedValue({
      observations: [{
        lexicon: "aws",
        resources: {
          webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK", attributes: { SubnetId: "subnet-old" } },
          launchTemplateServer: { type: "AWS::EC2::Instance", physicalId: "i-2", status: "OK", attributes: {} },
        },
      }],
      commit: "a1b2c3d4e5f6", timestamp: "2026-08-01T03:15:00.000Z", depth: "identity",
    });
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "aws",
        describeResources: async () => ({
          webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK", attributes: { SubnetId: "subnet-new" } },
          launchTemplateServer: { type: "AWS::EC2::Instance", physicalId: "i-2", status: "OK", attributes: {} },
          dbServer: { type: "AWS::RDS::Instance", physicalId: "db-1", status: "OK" },
        }),
      }),
    ]);
    const exit = await runSearch({
      args: makeArgs({ path: "kind:EC2::Instance", at: "latest", checkLive: true }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(0);
    const stdout = out.join("\n");
    expect(stdout).toContain("webServer  attributes.SubnetId: subnet-old → subnet-new — drifted");
    expect(stdout).toContain("checked against a live read · 1 of 2 matched drifted");
    // dbServer isn't matched by kind:EC2::Instance and must never enter the diff.
    expect(stdout).not.toContain("dbServer");
  });

  test("--fail-on-drift exits non-zero when the scoped check finds drift", async () => {
    replaySnapshotsMock.mockResolvedValue({
      observations: [{ lexicon: "aws", resources: { webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK" } } }],
      commit: "a1b2c3d", timestamp: "t", depth: "identity",
    });
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "aws",
        describeResources: async () => ({
          webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "UPDATING" },
        }),
      }),
    ]);
    const exit = await runSearch({
      args: makeArgs({ path: "kind:EC2::Instance", at: "latest", checkLive: true, failOnDrift: true }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(1);
  });

  test("no drift exits 0 even with --fail-on-drift", async () => {
    replaySnapshotsMock.mockResolvedValue({
      observations: [{ lexicon: "aws", resources: { webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK" } } }],
      commit: "a1b2c3d", timestamp: "t", depth: "identity",
    });
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "aws",
        describeResources: async () => ({
          webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK" },
        }),
      }),
    ]);
    const exit = await runSearch({
      args: makeArgs({ path: "webServer", at: "latest", checkLive: true, failOnDrift: true }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(0);
    expect(out.join("\n")).toContain("no drift across 1 matched");
  });

  test("--live --check-snapshot: a resource newly observed since the snapshot", async () => {
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "aws",
        describeResources: async () => ({
          webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK" },
        }),
      }),
    ]);
    replaySnapshotsMock.mockResolvedValue({
      observations: [{ lexicon: "aws", resources: {} }],
      commit: "a1b2c3d", timestamp: "t", depth: "identity",
    });
    const exit = await runSearch({
      args: makeArgs({ path: "webServer", live: true, checkSnapshot: true }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(0);
    expect(out.join("\n")).toContain("webServer — newly observed since the recorded snapshot");
  });

  test("--check-snapshot with nothing recorded is a note, not a failure", async () => {
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "aws",
        describeResources: async () => ({
          webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK" },
        }),
      }),
    ]);
    replaySnapshotsMock.mockResolvedValue({ error: `No snapshots found for environment "dev"` });
    const exit = await runSearch({
      args: makeArgs({ path: "kind:EC2::Instance", live: true, checkSnapshot: true }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(0);
    expect(err.join("\n")).toContain("--check-snapshot: No snapshots found");
    expect(out.join("\n")).not.toContain("checked against");
  });

  test("a live read that fails during --check-live reports unobserved, never missing (#1089)", async () => {
    replaySnapshotsMock.mockResolvedValue({
      observations: [{ lexicon: "aws", resources: { webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK" } } }],
      commit: "a1b2c3d", timestamp: "t", depth: "identity",
    });
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "aws",
        describeResources: async () => { throw new Error("ECONNREFUSED"); },
      }),
    ]);
    const exit = await runSearch({
      args: makeArgs({ path: "kind:EC2::Instance", at: "latest", checkLive: true }),
      plugins: [], serializers: [],
    });
    // The check-live read itself failed, which is the existing --live failure
    // path (#1263) — a real problem distinct from any drift verdict.
    expect(exit).toBe(1);
    const stdout = out.join("\n");
    expect(stdout).toContain("? webServer");
    expect(stdout).not.toContain("missing");
  });

  test("depth note: a deep-recorded snapshot compared here at identity says so", async () => {
    replaySnapshotsMock.mockResolvedValue({
      observations: [{ lexicon: "aws", resources: { webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK" } } }],
      commit: "a1b2c3d", timestamp: "t", depth: "deep",
    });
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "aws",
        describeResources: async () => ({
          webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK" },
        }),
      }),
    ]);
    const exit = await runSearch({
      args: makeArgs({ path: "webServer", at: "latest", checkLive: true }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(0);
    expect(out.join("\n")).toContain("snapshot recorded at deep depth, compared here at identity");
  });
});
