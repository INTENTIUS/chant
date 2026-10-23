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

import type { ResourceMetadata } from "../../lexicon";
import searchSchema from "../../workspace/search.schema.json";
import { contract } from "../../workspace/__fixtures__/contract-repo";
const { expectValid } = contract(searchSchema);
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

// #4358 — a terraform root's blocks exist only once `buildRoots()` renders the
// root, and `--live` built without it, so no terraform root was ever observed
// and a plan attribute could never be matched. The live path now builds roots
// and joins them to the declared canvas, as `chant graph --live` does.
describe("search --live over build-root entities (#4358)", () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { out.push(`ERR ${s}`); });
    discoverMock.mockReset();
    discoverMock.mockImplementation(async () => ({ entities: new Map(), errors: [], sourceFiles: [] }));
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveLexMock.mockReset();
    resolveLexMock.mockResolvedValue(["terraform"]);
    hasSnapshotMock.mockReset();
    hasSnapshotMock.mockResolvedValue(false);
  });

  test("builds roots, observes their blocks and matches the attributes the read put on them", async () => {
    const rooted = new Map<string, Declarable>([
      ["app/terraform_data.replaced", decl({ lexicon: "terraform", entityType: "Terraform::Resource", props: {} })],
    ]);
    buildResultMock.mockReset();
    buildResultMock.mockImplementation((_src: unknown, _s: unknown, _x: unknown, opts?: { buildRoots?: unknown[] }) => ({
      errors: [],
      entities: (opts?.buildRoots?.length ?? 0) > 0 ? rooted : new Map(),
      outputs: new Map([["terraform", ""]]),
      warnings: [],
    }));
    loadPluginsMock.mockResolvedValue([
      {
        // createMockPlugin has no `buildRoots` option; the hook is spread on.
        ...createMockPlugin({
          name: "terraform",
          describeResources: async ({ entityNames }: { entityNames: string[] }) =>
            Object.fromEntries(
            entityNames.map((n) => [n, { type: "Terraform::Resource", physicalId: "id-1", status: "managed", ownership: "owned", owned: true, attributes: { planAction: "replace" } }]),
            ),
        }),
        buildRoots: async () => ({ entities: rooted, warnings: [] }),
      },
    ]);
    const exit = await runSearch({ args: makeArgs({ path: "attr:planAction=replace" }), plugins: [], serializers: [] });
    expect(out.join("\n")).toContain("app/terraform_data.replaced  terraform_data  id-1");
    expect(exit).toBe(0);
  });
});

// #4372 — a planned create is absent, and the plan's attributes ride beside
// the verdict as annotations. The handler puts them on the declared row, so
// `attr:planAction=create` matches a block that does not exist yet, and the
// row still has no physical id.
describe("search --live over a planned create (#4372)", () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { out.push(`ERR ${s}`); });
    discoverMock.mockReset();
    discoverMock.mockImplementation(async () => ({ entities: new Map(), errors: [], sourceFiles: [] }));
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveLexMock.mockReset();
    resolveLexMock.mockResolvedValue(["terraform"]);
    hasSnapshotMock.mockReset();
    hasSnapshotMock.mockResolvedValue(false);
  });

  test("attr:planAction=create and attr:planAfterUnknown=id match it, and it stays without a physical id", async () => {
    const rooted = new Map<string, Declarable>([
      ["app/terraform_data.replaced", decl({ lexicon: "terraform", entityType: "Terraform::Resource", props: {} })],
      ["app/terraform_data.created", decl({ lexicon: "terraform", entityType: "Terraform::Resource", props: {} })],
    ]);
    buildResultMock.mockReset();
    buildResultMock.mockImplementation((_src: unknown, _s: unknown, _x: unknown, opts?: { buildRoots?: unknown[] }) => ({
      errors: [],
      entities: (opts?.buildRoots?.length ?? 0) > 0 ? rooted : new Map(),
      outputs: new Map([["terraform", ""]]),
      warnings: [],
    }));
    loadPluginsMock.mockResolvedValue([
      {
        ...createMockPlugin({
          name: "terraform",
          describeResources: async () => ({
            observation: "v1",
            resources: {
              "app/terraform_data.replaced": { type: "Terraform::Resource", physicalId: "id-1", status: "managed", ownership: "owned", attributes: { planAction: "replace" } },
            },
            annotations: { "app/terraform_data.created": { planAction: "create", planAfterUnknown: ["id", "input"] } },
          }),
        }),
        buildRoots: async () => ({ entities: rooted, warnings: [] }),
      },
    ]);

    expect(await runSearch({ args: makeArgs({ path: "attr:planAction=create", json: true }), plugins: [], serializers: [] })).toBe(0);
    const json = JSON.parse(out.filter((l) => !l.startsWith("ERR ")).join("\n")) as { matches: Array<{ id: string; physicalId?: string | null }> };
    expect(json.matches.map((m) => m.id)).toEqual(["app/terraform_data.created"]);
    expect(json.matches[0]!.physicalId ?? null).toBeNull();

    out = [];
    expect(await runSearch({ args: makeArgs({ path: "attr:planAfterUnknown=id" }), plugins: [], serializers: [] })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("app/terraform_data.created");
    expect(text).not.toContain("app/terraform_data.replaced");
  });
});

// #4381 — when every match is a planned create, the live read worked and found
// nothing bound yet. "returned no bound resources" read like a failed read.
describe("search --live provenance when every match is a planned create (#4381)", () => {
  let out: string[];

  function setup(annotations: Record<string, Record<string, unknown>> | undefined, names: string[]) {
    const rooted = new Map<string, Declarable>(
      names.map((n) => [n, decl({ lexicon: "terraform", entityType: "Terraform::Resource", props: {} })]),
    );
    buildResultMock.mockReset();
    buildResultMock.mockImplementation((_src: unknown, _s: unknown, _x: unknown, opts?: { buildRoots?: unknown[] }) => ({
      errors: [],
      entities: (opts?.buildRoots?.length ?? 0) > 0 ? rooted : new Map(),
      outputs: new Map([["terraform", ""]]),
      warnings: [],
    }));
    loadPluginsMock.mockResolvedValue([
      {
        ...createMockPlugin({
          name: "terraform",
          describeResources: async () => ({ observation: "v1", resources: {}, ...(annotations ? { annotations } : {}) }),
        }),
        buildRoots: async () => ({ entities: rooted, warnings: [] }),
      },
    ]);
  }

  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { out.push(`ERR ${s}`); });
    discoverMock.mockReset();
    discoverMock.mockImplementation(async () => ({ entities: new Map(), errors: [], sourceFiles: [] }));
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveLexMock.mockReset();
    resolveLexMock.mockResolvedValue(["terraform"]);
    hasSnapshotMock.mockReset();
    hasSnapshotMock.mockResolvedValue(false);
  });

  const planned = { "app/a": { planAction: "create" }, "app/b": { planAction: "create" } };

  test("text footer and --json provenance say planned creates, and plannedCreates carries the count", async () => {
    setup(planned, ["app/a", "app/b"]);
    expect(await runSearch({ args: makeArgs({ path: "attr:planAction=create" }), plugins: [], serializers: [] })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("2 planned creates, none bound yet");
    expect(text).not.toContain("returned no bound resources");

    out = [];
    expect(await runSearch({ args: makeArgs({ path: "attr:planAction=create", json: true }), plugins: [], serializers: [] })).toBe(0);
    const doc = JSON.parse(out.filter((l) => !l.startsWith("ERR ")).join("\n")) as { provenance: string; plannedCreates?: number };
    expectValid(doc);
    expect(doc.provenance).toContain("2 planned creates, none bound yet");
    expect(doc.plannedCreates).toBe(2);
  });

  test("a real empty live read keeps its wording and carries no plannedCreates", async () => {
    setup(undefined, ["app/a", "app/b"]);
    expect(await runSearch({ args: makeArgs({ path: "kind:Terraform::Resource" }), plugins: [], serializers: [] })).toBe(0);
    expect(out.join("\n")).toContain("live read returned no bound resources");
    expect(out.join("\n")).not.toContain("planned create");

    out = [];
    expect(await runSearch({ args: makeArgs({ path: "kind:Terraform::Resource", json: true }), plugins: [], serializers: [] })).toBe(0);
    const doc = JSON.parse(out.filter((l) => !l.startsWith("ERR ")).join("\n")) as { provenance: string; plannedCreates?: number };
    expectValid(doc);
    expect(doc.provenance).toContain("live read returned no bound resources");
    expect(doc.plannedCreates).toBeUndefined();
  });
});

// #4384 - a plan-depth answer said "observed live". Each row carries the read
// that answered it (`sources`, #2267), and the line and --json name it.
describe("search --live names the plan read (#4384)", () => {
  let out: string[];
  const entities = new Map<string, Declarable>([
    ["orders", decl({ lexicon: "terraform", entityType: "Terraform::Resource", props: {} })],
  ]);
  const PLAN_NOTE = "terraform.roots.app: the plan read answered (`terraform plan -input=false -lock=false -out=<tmp>/plan.tfplan`)";
  const STATE_NOTE = "terraform.roots.app: the plan read failed (no provider credentials: x), so the state read answered; plan attributes are absent";
  const DECLARED_NOTE = "terraform.roots.app: no read answered, declared only (the plan read could not reach the backend)";

  function setup(sources: Record<string, string>, notes: string[], resources: Record<string, ResourceMetadata> | null = null) {
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "terraform",
        describeResources: async () => ({
          observation: "v1" as const,
          resources: resources ?? { orders: { type: "Terraform::Resource", physicalId: "db-1", status: "OK", ownership: "owned" as const } },
          sources,
          notes,
        }),
      }),
    ]);
  }

  async function run(json = false) {
    out = [];
    const exit = await runSearch({ args: makeArgs({ path: "kind:Terraform::Resource", json }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    return out.filter((l) => !l.startsWith("ERR ")).join("\n");
  }

  beforeEach(() => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { out.push(`ERR ${s}`); });
    discoverMock.mockReset();
    discoverMock.mockResolvedValue({ entities, errors: [], sourceFiles: [] });
    buildResultMock.mockReset();
    buildResultMock.mockReturnValue({ errors: [], entities, outputs: new Map([["terraform", ""]]), warnings: [] });
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveLexMock.mockReset();
    resolveLexMock.mockResolvedValue(["terraform"]);
    hasSnapshotMock.mockReset();
    hasSnapshotMock.mockResolvedValue(false);
  });

  test("a plan answer names the plan depth in the line and in --json", async () => {
    setup({ orders: "plan" }, [PLAN_NOTE]);
    expect(await run()).toContain("observed at the plan depth (terraform plan -lock=false) · bound 1/1");
    const doc = JSON.parse(await run(true));
    expectValid(doc);
    expect(doc.source).toMatchObject({ kind: "live", depth: "plan", reads: ["plan"] });
    expect(doc.provenance).toBe("observed at the plan depth (terraform plan -lock=false) · bound 1/1");
  });

  test("a live+plan answer names both reads", async () => {
    setup({ orders: "live+plan" }, [PLAN_NOTE]);
    const text = await run();
    expect(text).toContain("observed live and at the plan depth (live-plan -json, terraform plan -lock=false) · bound 1/1");
    const doc = JSON.parse(await run(true));
    expectValid(doc);
    expect(doc.source.depth).toBe("live+plan");
  });

  test("matches read at different depths name both", async () => {
    setup(
      { a: "plan", b: "state" },
      [PLAN_NOTE],
      {
        a: { type: "Terraform::Resource", physicalId: "x", status: "OK", ownership: "owned" as const },
        b: { type: "Terraform::Resource", physicalId: "y", status: "OK", ownership: "owned" as const },
      },
    );
    entities.set("a", decl({ lexicon: "terraform", entityType: "Terraform::Resource", props: {} }));
    entities.set("b", decl({ lexicon: "terraform", entityType: "Terraform::Resource", props: {} }));
    try {
      const doc = JSON.parse(await run(true));
      expectValid(doc);
      expect(doc.source).toMatchObject({ depth: "mixed", reads: ["plan", "state"] });
      expect(doc.provenance).toContain("at the plan depth (terraform plan -lock=false) and from state");
    } finally {
      entities.delete("a");
      entities.delete("b");
    }
  });

  test("a plan read that fell back to state says so", async () => {
    setup({ orders: "state" }, [STATE_NOTE]);
    const text = await run();
    expect(text).toContain("observed live · bound 1/1 · the plan read fell back to state");
    const doc = JSON.parse(await run(true));
    expectValid(doc);
    expect(doc.source.planFellBackTo).toBe("state");
    expect(doc.source.depth).toBeUndefined();
  });

  test("a plan read that fell back to declared says so", async () => {
    setup(
      { orders: "plan" },
      [DECLARED_NOTE],
      null,
    );
    loadPluginsMock.mockResolvedValue([
      createMockPlugin({
        name: "terraform",
        describeResources: async () => ({
          observation: "v1" as const,
          resources: {},
          unobserved: { orders: { reason: "no-binding" as const, type: "Terraform::Resource" } },
          sources: { orders: "plan" },
          notes: [DECLARED_NOTE],
        }),
      }),
    ]);
    const doc = JSON.parse(await run(true));
    expectValid(doc);
    expect(doc.source.planFellBackTo).toBe("declared");
    expect(doc.source.depth).toBeUndefined();
    expect(doc.provenance).toContain("the plan read fell back to declared");
  });

  test("a plain live or state answer is unchanged", async () => {
    setup({ orders: "state" }, []);
    expect(await run()).toContain("observed live · bound 1/1");
    expect(await run()).not.toContain("plan");
    const doc = JSON.parse(await run(true));
    expectValid(doc);
    expect(doc.source).toEqual({ kind: "live", env: "dev" });
  });
});
