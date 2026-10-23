import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ParsedArgs } from "../registry";
import { DECLARABLE_MARKER, type Declarable } from "../../declarable";
import { createMockPlugin } from "../../../../test-utils/src/mock-plugin";
import { parseArgs } from "../parse-args";

// #4367: `chant search --json` is the whole answer as one document on stdout:
// full node ids, displayId, show, provenance, explain, drift, live failures
// and refusals. #4369: a query that opens with `->` reaches the handler.

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

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "search", path: "kind:Instance",
    format: "", fix: false, watch: false, verbose: false, help: false, live: false, json: true,
    ...overrides,
  };
}

const instance = (props: Record<string, unknown> = {}) => decl({ lexicon: "aws", entityType: "AWS::EC2::Instance", props });
const entities = new Map<string, Declarable>([
  ["webServer", instance({ InstanceType: "t3.micro" })],
  ["privateServer", instance({ InstanceType: "t3.large" })],
  ["bucket", decl({ lexicon: "aws", entityType: "AWS::S3::Bucket", props: {} })],
]);

let out: string[];
let err: string[];

async function search(args: Partial<ParsedArgs>): Promise<{ exit: number; doc: ReturnType<typeof JSON.parse> }> {
  const exit = await runSearch({ args: makeArgs(args), plugins: [], serializers: [] });
  // One document, and nothing else on stdout.
  expect(out).toHaveLength(1);
  return { exit, doc: JSON.parse(out[0]) };
}

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
  loadPluginsMock.mockReset();
  loadPluginsMock.mockResolvedValue([]);
  hasSnapshotMock.mockReset();
  hasSnapshotMock.mockResolvedValue(false);
  replaySnapshotsMock.mockReset();
});

describe("search --json on two stacks with the same name (#4367)", () => {
  test("rows carry distinct stack-qualified ids, where the text rows print the same name twice", async () => {
    loadChantConfigMock.mockResolvedValue({ config: { stacks: [{ name: "east", src: "east" }, { name: "west", src: "west" }] } });
    discoverMock.mockImplementation(async (path: string) => ({
      entities: new Map([["web", instance()]]),
      errors: [],
      sourceFiles: [path],
    }));
    replaySnapshotsMock.mockResolvedValue({
      observations: [{
        lexicon: "aws",
        resources: {
          "east::web": { type: "AWS::EC2::Instance", physicalId: "i-east", status: "OK" },
          "west::web": { type: "AWS::EC2::Instance", physicalId: "i-west", status: "OK" },
        },
      }],
      commit: "a1b2c3d4e5f6", timestamp: "2026-08-01T03:15:00.000Z", depth: "identity",
    });
    loadPluginsMock.mockResolvedValue([createMockPlugin({ name: "aws", describeResources: async () => ({}) })]);
    const { exit, doc } = await search({ path: "kind:EC2::Instance", at: "latest", env: "prod" });
    expect(exit).toBe(0);
    expect(doc.source).toEqual({ kind: "snapshot", commit: "a1b2c3d4e5f6", timestamp: "2026-08-01T03:15:00.000Z", env: "prod" });
    expect(doc.matches.map((m: { id: string }) => m.id).sort()).toEqual(["east::web", "west::web"]);
    expect(doc.matches.map((m: { displayId: string }) => m.displayId)).toEqual(["web", "web"]);
    expect(doc.matches.map((m: { physicalId: string }) => m.physicalId).sort()).toEqual(["i-east", "i-west"]);
    expect(doc.provenance).toBe("observed from snapshot a1b2c3d taken 2026-08-01T03:15:00.000Z · bound 2/2");

    // The text rows are the bare name, which is why the ids are needed.
    out = [];
    await runSearch({ args: makeArgs({ path: "kind:EC2::Instance", at: "latest", env: "prod", json: undefined }), plugins: [], serializers: [] });
    expect(out.filter((l) => l.startsWith("web  "))).toEqual(["web  AWS::EC2::Instance  i-east", "web  AWS::EC2::Instance  i-west"]);
  });
});

describe("search --json carries the text footers as fields (#4367)", () => {
  test("declared: displayId, show, provenance; no env on a declared source", async () => {
    const { exit, doc } = await search({ path: "kind:EC2::Instance", show: "instancetype,Missing" });
    expect(exit).toBe(0);
    expect(doc.source).toEqual({ kind: "declared" });
    expect([...doc.matches].sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: "privateServer", displayId: "privateServer", kind: "AWS::EC2::Instance", show: { InstanceType: "t3.large" }, paths: [] },
      { id: "webServer", displayId: "webServer", kind: "AWS::EC2::Instance", show: { InstanceType: "t3.micro" }, paths: [] },
    ]);
    expect(doc.provenance).toBe("declared only · no observation · physical ids unavailable");
    expect(doc).not.toHaveProperty("explain");
    expect(doc).not.toHaveProperty("drift");
  });

  test("--explain: universe, near-misses by the term they fail", async () => {
    const { doc } = await search({ path: "kind:EC2::Instance attr:InstanceType=micro", explain: true });
    expect(doc.matches.map((m: { id: string }) => m.id)).toEqual(["webServer"]);
    expect(doc.explain).toEqual({
      universe: { matched: 1, of: 2, kinds: ["AWS::EC2::Instance"] },
      evidence: [],
      nearMisses: [{ id: "privateServer", fails: "attr:InstanceType=micro" }],
      moreExcluded: 0,
    });
  });

  test("no matches is a document with an empty list, not \"(no matches)\"", async () => {
    const { exit, doc } = await search({ path: "kind:Lambda", explain: true });
    expect(exit).toBe(0);
    expect(doc.matches).toEqual([]);
    expect(doc.explain.universe).toEqual({ matched: 0, of: 3, kinds: [] });
  });

  test("a failed live read: liveFailures, each row unobserved, exit 1", async () => {
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({ name: "aws", describeResources: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9999"); } }),
    ]);
    const { exit, doc } = await search({ path: "kind:EC2::Instance", live: true, env: "dev" });
    expect(exit).toBe(1);
    expect(doc.source).toEqual({ kind: "live", env: "dev" });
    expect(doc.liveFailures).toHaveLength(1);
    expect(doc.liveFailures[0]).toContain("ECONNREFUSED");
    expect(doc.matches.map((m: { unobserved: string }) => m.unobserved)).toEqual(["read-failed", "read-failed"]);
    expect(doc.provenance).toBe("live read failed (aws) · 2/2 rows unobserved · answered from the declared graph · physical ids unavailable");
    expect(err.join("\n")).toContain("ECONNREFUSED");
  });
});

describe("search --json refusals are a document with error, exit 1 (#4367)", () => {
  test("a query the grammar refuses carries chant's hint", async () => {
    const { exit, doc } = await search({ path: "effectiveIngress:tcp:22" });
    expect(exit).toBe(1);
    expect(doc).toEqual({
      query: "effectiveIngress:tcp:22",
      error: {
        message: "\"effectiveIngress:tcp:22\" is not a term — there is no \"effectiveIngress:\" prefix",
        hint: "for an attribute, say attr:effectiveIngress=tcp:22; the prefixes are kind:, attr:, tag:, and ->/<- for edges",
      },
    });
    expect(err.join("\n")).toContain("is not a term");
  });

  test("--live without --env", async () => {
    const { exit, doc } = await search({ path: "kind:EC2::Instance", live: true });
    expect(exit).toBe(1);
    expect(doc).toEqual({ query: "kind:EC2::Instance", error: { message: "chant search --live needs an environment: --live --env <name>" } });
  });

  test("without --json a refusal prints nothing on stdout, as before", async () => {
    const exit = await runSearch({ args: makeArgs({ path: "->", json: undefined }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(out).toEqual([]);
  });
});

describe("search --json with --check-live (#4367)", () => {
  const snapshot = {
    observations: [{
      lexicon: "aws",
      resources: {
        webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK", attributes: { SubnetId: "subnet-old" } },
        privateServer: { type: "AWS::EC2::Instance", physicalId: "i-2", status: "OK", attributes: {} },
      },
    }],
    commit: "a1b2c3d4e5f6", timestamp: "2026-08-01T03:15:00.000Z", depth: "identity",
  };
  const liveNow = createMockPlugin({
    name: "aws",
    describeResources: async () => ({
      webServer: { type: "AWS::EC2::Instance", physicalId: "i-1", status: "OK", attributes: { SubnetId: "subnet-new" } },
      privateServer: { type: "AWS::EC2::Instance", physicalId: "i-2", status: "OK", attributes: {} },
    }),
  });

  test("drift is a field, scoped to the matched rows", async () => {
    replaySnapshotsMock.mockResolvedValue(snapshot);
    loadPluginsMock.mockResolvedValue([liveNow]);
    const { exit, doc } = await search({ path: "kind:EC2::Instance", at: "latest", env: "dev", checkLive: true });
    expect(exit).toBe(0);
    expect(doc.drift).toMatchObject({
      against: "live",
      checked: 2,
      count: 1,
      missing: [],
      orphan: [],
      disappeared: [],
      drifted: [{ id: "webServer", path: "attributes.SubnetId", old: "subnet-old", new: "subnet-new" }],
    });
  });

  test("--fail-on-drift exits 1 with the document printed", async () => {
    replaySnapshotsMock.mockResolvedValue(snapshot);
    loadPluginsMock.mockResolvedValue([liveNow]);
    const { exit, doc } = await search({ path: "kind:EC2::Instance", at: "latest", env: "dev", checkLive: true, failOnDrift: true });
    expect(exit).toBe(1);
    expect(doc.drift.count).toBe(1);
  });

  test("--check-snapshot with no snapshot says so in drift.unavailable", async () => {
    replaySnapshotsMock.mockResolvedValue({ error: "no snapshot recorded for dev" });
    loadPluginsMock.mockResolvedValue([liveNow]);
    const { exit, doc } = await search({ path: "kind:EC2::Instance", live: true, env: "dev", checkSnapshot: true });
    expect(exit).toBe(0);
    expect(doc.drift).toEqual({ against: "snapshot", unavailable: "no snapshot recorded for dev" });
  });
});

describe("a query that opens with -> reaches the search (#4369)", () => {
  test("chant search \"->kind:S3::Bucket\" --json searches for that, not for \".\"", async () => {
    const entitiesWithRef = new Map<string, Declarable>([
      ["web", instance({ Bucket: { $ref: "bucket" } })],
      ["bucket", decl({ lexicon: "aws", entityType: "AWS::S3::Bucket", props: {} })],
    ]);
    discoverMock.mockResolvedValue({ entities: entitiesWithRef, errors: [], sourceFiles: [] });
    for (const argv of [["search", "->kind:S3::Bucket", "--json"], ["search", "->kind:S3::Bucket", "--explain", "--json"]]) {
      out = [];
      const exit = await runSearch({ args: parseArgs(argv), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      const doc = JSON.parse(out[0]);
      expect(doc.query).toBe("->kind:S3::Bucket");
    }
  });
});
