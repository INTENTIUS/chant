import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ParsedArgs } from "../registry";
import { DECLARABLE_MARKER, type Declarable } from "../../declarable";
import { createMockPlugin } from "../../../../test-utils/src/mock-plugin";

// #1263 — `chant search --live` against an unreachable endpoint returned the
// declared rows, exit 0, and a footer naming derived facts it never computed.
// The observe layer already records a thrown read as NOT-OBSERVED
// (`read-failed`, #1089); these tests pin that the handler carries it through
// to the rows, the footer, stderr, and the exit code. `observeResources` is
// real here so the plumbing from a throwing `describeResources` is exercised.

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
const hasSnapshotMock = vi.fn((..._a: unknown[]) => Promise.resolve(false));
vi.mock("../../lifecycle/replay", () => ({
  replaySnapshots: vi.fn(),
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

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "search", path: "kind:Instance",
    format: "", fix: false, watch: false, verbose: false, help: false, live: true, env: "dev",
    ...overrides,
  };
}

describe("search --live when the live read fails (#1263)", () => {
  let out: string[];
  let err: string[];
  const entities = new Map<string, Declarable>([
    ["webServer", decl({ lexicon: "aws", entityType: "AWS::EC2::Instance", props: {} })],
    ["privateServer", decl({ lexicon: "aws", entityType: "AWS::EC2::Instance", props: {} })],
  ]);

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
  });

  const deadEndpoint = createMockPlugin({
    name: "aws",
    describeResources: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
    },
  });

  test("exits non-zero, names the lexicon and cause, and marks every row unobserved", async () => {
    loadPluginsMock.mockResolvedValue([deadEndpoint]);
    const exit = await runSearch({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    const stderr = err.join("\n");
    expect(stderr).toContain("aws");
    expect(stderr).toContain("ECONNREFUSED 127.0.0.1:9999");
    expect(stderr).toContain("declared-only");
    const stdout = out.join("\n");
    expect(stdout).toContain("webServer  AWS::EC2::Instance  (unobserved: read-failed)");
    expect(stdout).toContain("privateServer  AWS::EC2::Instance  (unobserved: read-failed)");
    expect(stdout).toContain("live read failed (aws) · 2/2 rows unobserved");
    // Nothing was read, so no fold over live topology could have run.
    expect(stdout).not.toContain("also derived");
  });

  test("points at a recorded snapshot when one exists", async () => {
    loadPluginsMock.mockResolvedValue([deadEndpoint]);
    hasSnapshotMock.mockResolvedValue(true);
    const exit = await runSearch({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(out.join("\n")).toContain("--at latest");
    expect(err.join("\n")).toContain("--at latest");
  });

  test("a working live read still exits 0 with bound rows", async () => {
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "aws",
        describeResources: async () => ({
          webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK", owned: true },
          privateServer: { type: "AWS::EC2::Instance", physicalId: "i-2", status: "OK", owned: true },
        }),
      }),
    ]);
    const exit = await runSearch({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const stdout = out.join("\n");
    expect(stdout).toContain("webServer  AWS::EC2::Instance  i-1");
    expect(stdout).toContain("observed live · bound 2/2");
    expect(err.join("\n")).not.toContain("live read failed");
  });
});
