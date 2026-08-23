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

// #1265 — a lexicon's run-level note ("ownership filter unavailable on this
// path") printed once per stack, ahead of the rows. It is one fact about the
// read, so it is said once, and it qualifies the answer, so it follows it.
describe("search --live run-level notes (#1265)", () => {
  const NOTE =
    "ownership filter unavailable on describeResources (no tags from describe-stack-resources) — returning all, each with an explicit `unknown` verdict; use `chant import --from <env> --owned` for ownership-filtered export";
  let out: string[];
  let err: string[];
  // One log of everything, in the order it was written, so the test can see
  // whether the note came before or after the rows.
  let all: string[];
  const entities = new Map<string, Declarable>([
    ["webServer", decl({ lexicon: "aws", entityType: "AWS::EC2::Instance", props: {} })],
    ["privateServer", decl({ lexicon: "aws", entityType: "AWS::EC2::Instance", props: {} })],
  ]);
  const calls: string[] = [];

  beforeEach(() => {
    out = [];
    err = [];
    all = [];
    calls.length = 0;
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(s); all.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { err.push(s); all.push(s); });
    vi.spyOn(console, "warn").mockImplementation((s: string) => { all.push(s); });
    discoverMock.mockReset();
    discoverMock.mockResolvedValue({ entities, errors: [], sourceFiles: [] });
    buildResultMock.mockReset();
    buildResultMock.mockReturnValue({ errors: [], entities, outputs: new Map([["aws", ""]]), warnings: [] });
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({
      config: { stacks: [{ name: "net" }, { name: "data" }, { name: "app" }, { name: "edge" }] },
    });
    resolveLexMock.mockReset();
    resolveLexMock.mockResolvedValue(["aws"]);
    hasSnapshotMock.mockReset();
    hasSnapshotMock.mockResolvedValue(false);
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "aws",
        describeResources: async (opts: { stack?: string }) => {
          calls.push(opts.stack ?? "");
          return {
            observation: "v1" as const,
            resources: {
              webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK", ownership: "unknown" as const },
              privateServer: { type: "AWS::EC2::Instance", physicalId: "i-2", status: "OK", ownership: "unknown" as const },
            },
            notes: [NOTE],
          };
        },
      }),
    ]);
  });

  test("four stacks, one note, after the rows and the provenance line", async () => {
    const exit = await runSearch({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(calls).toEqual(["net", "data", "app", "edge"]);
    const notes = all.filter((line) => line.includes("ownership filter unavailable"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`[aws] ${NOTE}`);
    const noteAt = all.findIndex((line) => line.includes("ownership filter unavailable"));
    const lastRow = all.findIndex((line) => line.startsWith("privateServer  AWS::EC2::Instance  i-2"));
    const footer = all.findIndex((line) => line.includes("observed live · bound 2/2"));
    expect(lastRow).toBeGreaterThanOrEqual(0);
    expect(footer).toBeGreaterThan(lastRow);
    expect(noteAt).toBeGreaterThan(footer);
    // stderr, like every other warning; the rows stay clean on stdout.
    expect(out.join("\n")).not.toContain("ownership filter unavailable");
    expect(err.join("\n")).toContain("ownership filter unavailable");
  });

  test("a miss still says the note, after the miss", async () => {
    const exit = await runSearch({ args: makeArgs({ path: "kind:Nope" }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const notes = all.filter((line) => line.includes("ownership filter unavailable"));
    expect(notes).toHaveLength(1);
    expect(all.indexOf("(no matches)")).toBeLessThan(all.findIndex((l) => l.includes("ownership filter unavailable")));
  });
});
