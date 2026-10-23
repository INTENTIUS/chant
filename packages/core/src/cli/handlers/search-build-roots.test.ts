import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ParsedArgs } from "../registry";
import { DECLARABLE_MARKER, type Declarable } from "../../declarable";
import type { LexiconPlugin } from "../../lexicon";
import { createMockPlugin } from "../../../../test-utils/src/mock-plugin";

// #4365 / #4368: search answers over the graph `chant graph` draws. That is
// discovery plus the build-root contributions (a terraform root, a kustomize
// root) plus the lexicons' `graphEdges`, on the declared path AND on the
// `--live`/`--at` canvas, and a contributor that throws fails the search
// instead of leaving it to answer `(no matches)` over a graph with a hole in it.

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
vi.mock("../../lifecycle/replay", () => ({
  replaySnapshots: (...a: unknown[]) => replaySnapshotsMock(...a),
  hasSnapshot: () => Promise.resolve(false),
}));
const loadChantConfigMock = vi.fn();
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return {
    ...actual,
    loadChantConfig: (...a: unknown[]) => loadChantConfigMock(...a),
    loadChantConfigUpward: (...a: unknown[]) => loadChantConfigMock(...a),
  };
});
const buildResultMock = vi.fn();
vi.mock("../../build", async () => {
  const actual = await vi.importActual<typeof import("../../build")>("../../build");
  return { ...actual, build: (...a: unknown[]) => Promise.resolve(buildResultMock(...a)) };
});

const { runSearch } = await import("./search");

function decl<T extends object>(base: T): Declarable & T {
  return { [DECLARABLE_MARKER]: true, ...base } as Declarable & T;
}

/** A lexicon whose only entities come from a build root, and whose only edge comes from `graphEdges`. */
function rootLexicon(overrides: Partial<LexiconPlugin> = {}): LexiconPlugin {
  return {
    ...createMockPlugin({ name: "tf" }),
    buildRoots: async () => ({
      entities: new Map<string, Declarable>([
        ["net/aws_vpc.main", decl({ lexicon: "tf", entityType: "Tf::Resource", props: { address: "aws_vpc.main" } })],
        ["net/aws_subnet.a", decl({ lexicon: "tf", entityType: "Tf::Resource", props: { address: "aws_subnet.a" } })],
      ]),
      warnings: [],
    }),
    graphEdges: () => ({ references: [{ from: "net/aws_subnet.a", to: "net/aws_vpc.main", kind: "ref", viaAttr: "vpc_id" }] }),
    ...overrides,
  };
}

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "search", path: "attr:address=aws_subnet ->attr:address=aws_vpc",
    format: "", fix: false, watch: false, verbose: false, help: false, live: false, json: true,
    ...overrides,
  };
}

describe("search over build-root entities and lexicon edges (#4365, #4368)", () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { err.push(s); });
    discoverMock.mockReset();
    // A fresh map per call: the merge writes into it.
    discoverMock.mockImplementation(async () => ({ entities: new Map(), errors: [], sourceFiles: [] }));
    buildResultMock.mockReset();
    buildResultMock.mockReturnValue({ errors: [], entities: new Map(), outputs: new Map(), warnings: [] });
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveLexMock.mockReset();
    resolveLexMock.mockResolvedValue(["tf"]);
    replaySnapshotsMock.mockReset();
  });

  test("declared: an edge term follows a lexicon edge between two build-root entities", async () => {
    loadPluginsMock.mockResolvedValue([rootLexicon()]);
    const exit = await runSearch({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const json = JSON.parse(out.join("\n"));
    expect(json.matches.map((m: { id: string }) => m.id)).toEqual(["net/aws_subnet.a"]);
    expect(json.matches[0].paths[0].hops).toEqual([{ from: "net/aws_subnet.a", to: "net/aws_vpc.main", fromAttr: "vpc_id" }]);
  });

  test("--at: the snapshot overlays onto a canvas that carries the build roots and their lexicon edges", async () => {
    loadPluginsMock.mockResolvedValue([rootLexicon({ describeResources: async () => ({}) })]);
    replaySnapshotsMock.mockResolvedValue({
      observations: [{
        lexicon: "tf",
        resources: {
          "net/aws_vpc.main": { type: "Tf::Resource", physicalId: "vpc-1", status: "OK" },
          "net/aws_subnet.a": { type: "Tf::Resource", physicalId: "subnet-1", status: "OK" },
        },
      }],
      commit: "a1b2c3d4e5f6", timestamp: "2026-10-01T00:00:00.000Z", depth: "identity",
    });
    const exit = await runSearch({ args: makeArgs({ at: "latest", env: "dev" }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const json = JSON.parse(out.join("\n"));
    expect(json.source.kind).toBe("snapshot");
    expect(json.matches.map((m: { id: string; physicalId?: string }) => [m.id, m.physicalId])).toEqual([["net/aws_subnet.a", "subnet-1"]]);
  });

  test("a contributor that throws fails the declared search with its error", async () => {
    loadPluginsMock.mockResolvedValue([rootLexicon({ buildRoots: async () => { throw new Error("roots.net: main.tf does not parse"); } })]);
    const exit = await runSearch({ args: makeArgs({ json: false }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(out.join("\n")).not.toContain("(no matches)");
    expect(err.join("\n")).toContain("roots.net: main.tf does not parse");
  });

  test("a contributor that throws fails the --at search too", async () => {
    loadPluginsMock.mockResolvedValue([rootLexicon({
      describeResources: async () => ({}),
      buildRoots: async () => { throw new Error("roots.net: main.tf does not parse"); },
    })]);
    replaySnapshotsMock.mockResolvedValue({ observations: [], commit: "a1b2c3d4e5f6", timestamp: "2026-10-01T00:00:00.000Z", depth: "identity" });
    const exit = await runSearch({ args: makeArgs({ json: false, at: "latest", env: "dev" }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(err.join("\n")).toContain("roots.net: main.tf does not parse");
  });
});
