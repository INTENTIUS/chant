import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BuildResult } from "../../build";
import type { ParsedArgs } from "../registry";
import { Scenario, snapshot } from "../../lifecycle/scenario";
import type { ResourceMetadata } from "../../lexicon";
import type { LifecycleSnapshot } from "../../lifecycle/types";

const buildMock = vi.fn();
const fetchLifecycleMock = vi.fn();
const readEnvironmentSnapshotsMock = vi.fn();
const loadChantConfigMock = vi.fn();

vi.mock("../../build", async () => {
  const actual = await vi.importActual<typeof import("../../build")>("../../build");
  return { ...actual, build: (...args: unknown[]) => buildMock(...args) };
});
vi.mock("../../lifecycle/git", () => ({
  fetchLifecycle: () => fetchLifecycleMock(),
  readEnvironmentSnapshots: (...args: unknown[]) => readEnvironmentSnapshotsMock(...args),
}));
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args) };
});

const { runScenarioCheck, runScenarioUnknown } = await import("./scenario");

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "scenario",
    path: "check",
    format: "",
    fix: false,
    watch: false,
    verbose: false,
    help: false,
    live: false,
    ...overrides,
  };
}

/** A synthetic BuildResult — same shape ./lifecycle.test.ts's makeBuildResult
 * uses: plain `{lexicon, entityType, props}` objects, not real Declarables,
 * since `isResourceDeclarable` only checks for a `props` key. Scenario
 * entities must be real `Scenario(...)` objects — collection keys on the
 * marker symbol. */
function makeBuildResult(
  resourcesByLexicon: Record<string, string[]>,
  scenarios: Record<string, ReturnType<typeof Scenario>>,
): BuildResult {
  const entities = new Map<string, unknown>();
  for (const [lexicon, names] of Object.entries(resourcesByLexicon)) {
    for (const name of names) entities.set(name, { lexicon, entityType: `${lexicon}::Mock`, props: {} });
  }
  for (const [name, decl] of Object.entries(scenarios)) entities.set(name, decl);
  return {
    outputs: new Map(Object.keys(resourcesByLexicon).map((l) => [l, "{}"])),
    entities,
    dependencies: new Map(),
    errors: [],
    warnings: [],
    manifest: { lexicons: Object.keys(resourcesByLexicon), outputs: {}, deployOrder: Object.keys(resourcesByLexicon) },
    sourceFileCount: 1,
  } as unknown as BuildResult;
}

const meta = (overrides: Partial<ResourceMetadata> = {}): ResourceMetadata => ({
  type: "AWS::S3::Bucket",
  status: "CREATE_COMPLETE",
  ownership: "owned",
  ...overrides,
});

const snap = (overrides: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot => ({
  lexicon: "aws",
  environment: "prod",
  commit: "abc123",
  timestamp: "2026-01-01T00:00:00Z",
  resources: {},
  ...overrides,
});

describe("runScenarioCheck", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];
  let tmpFiles: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    tmpFiles = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    buildMock.mockReset();
    fetchLifecycleMock.mockReset();
    fetchLifecycleMock.mockResolvedValue(undefined);
    readEnvironmentSnapshotsMock.mockReset();
    readEnvironmentSnapshotsMock.mockResolvedValue(new Map());
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: { environments: [{ name: "prod" }, { name: "staging" }] } });
  });

  afterEach(async () => {
    for (const d of tmpFiles) await rm(d, { recursive: true, force: true });
  });

  function combined(): string {
    return [...stdoutBuf, ...stderrBuf].join("\n");
  }

  async function writeFixture(content: LifecycleSnapshot): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "chant-scenario-"));
    const path = join(dir, "baseline.json");
    await writeFile(path, JSON.stringify(content));
    tmpFiles.push(dir);
    return path;
  }

  test("no scenarios declared: exits 0 and says so", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }, {}));
    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(stdoutBuf.join("\n")).toContain("No scenarios declared");
  });

  test("build failure exits 1 before any scenario runs", async () => {
    buildMock.mockResolvedValue({ ...makeBuildResult({}, {}), errors: [{}] });
    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderrBuf.join("\n")).toContain("Build failed");
  });

  test("a noop scenario passes against a fixture matching the declared entity", async () => {
    const fixturePath = await writeFixture(snap({ resources: { bucket: meta() } }));
    const scenario = Scenario("plan-neutral", { given: snapshot(fixturePath), expect: { noop: true } });
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }, { plan: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(stdoutBuf.join("\n")).toContain("plan-neutral");
    expect(stdoutBuf.join("\n")).toContain("PASS");
  });

  test("a noop scenario fails with a legible detail when the fixture lacks a declared resource (create proposed)", async () => {
    const fixturePath = await writeFixture(snap({ resources: {} }));
    const scenario = Scenario("should-be-neutral", { given: snapshot(fixturePath), expect: { noop: true } });
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }, { plan: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("FAIL");
    expect(out).toContain("noop:");
    expect(out).toContain("1 create");
    expect(out).toContain("bucket");
  });

  test("a deletes scenario passes when the fixture's extra owned resource is proposed for delete", async () => {
    const fixturePath = await writeFixture(snap({ resources: { legacy: meta({ ownership: "owned" }) } }));
    const scenario = Scenario("drop legacy", {
      given: snapshot(fixturePath),
      expect: { deletes: [{ name: "legacy", ownership: "owned" }], create: 0, update: 0 },
    });
    buildMock.mockResolvedValue(makeBuildResult({}, { plan: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
  });

  // buildChangeSet never classifies a non-owned resource as `delete` (only
  // `adopt`) — the ownership safety property is structural, upstream of
  // evaluateScenario. A `deletes` expectation against a foreign resource
  // therefore fails as "not proposed", never as an ownership mismatch; that
  // IS the assertion worth making — the scenario correctly refuses to treat
  // an adopt candidate as the delete it expected.
  test("a deletes scenario fails and names the resource when the fixture marks it foreign (never auto-deleted)", async () => {
    const fixturePath = await writeFixture(snap({ resources: { legacy: meta({ ownership: "foreign" }) } }));
    const scenario = Scenario("drop legacy", {
      given: snapshot(fixturePath),
      expect: { deletes: [{ name: "legacy", ownership: "owned" }] },
    });
    buildMock.mockResolvedValue(makeBuildResult({}, { plan: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("deletes:");
    expect(out).toContain("legacy");
    expect(out).toContain("not proposed for delete");
  });

  test("given: snapshot(path) — a missing fixture file fails the scenario, not the whole run", async () => {
    const scenario = Scenario("s", { given: snapshot("fixtures/does-not-exist.json"), expect: { noop: true } });
    buildMock.mockResolvedValue(makeBuildResult({}, { plan: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stdoutBuf.join("\n")).toContain("fixture not found");
  });

  test("given: snapshot(env) — an unknown environment fails with the declared-environments hint", async () => {
    const scenario = Scenario("s", { given: snapshot("nowhere"), expect: { noop: true } });
    buildMock.mockResolvedValue(makeBuildResult({}, { plan: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stdoutBuf.join("\n")).toMatch(/Unknown environment/);
  });

  test("given: snapshot(env) — no recorded snapshot fails with a recording hint", async () => {
    readEnvironmentSnapshotsMock.mockResolvedValue(new Map());
    const scenario = Scenario("s", { given: snapshot("prod"), expect: { noop: true } });
    buildMock.mockResolvedValue(makeBuildResult({}, { plan: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stdoutBuf.join("\n")).toContain("chant lifecycle snapshot prod");
    expect(fetchLifecycleMock).toHaveBeenCalled();
  });

  test("given: snapshot(env) — replays every recorded lexicon's snapshot", async () => {
    readEnvironmentSnapshotsMock.mockResolvedValue(
      new Map([["aws", JSON.stringify(snap({ resources: { bucket: meta() } }))]]),
    );
    const scenario = Scenario("s", { given: snapshot("prod"), expect: { noop: true } });
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }, { plan: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
  });

  test("a lexicon the fixture doesn't cover is marked unobserved, not silently create", async () => {
    const fixturePath = await writeFixture(snap({ lexicon: "aws", resources: { bucket: meta() } }));
    const scenario = Scenario("multi-lexicon", {
      given: snapshot(fixturePath),
      expect: { unobserved: "refuse" },
    });
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"], k8s: ["web"] }, { plan: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("unobserved:");
    expect(out).toContain("web");
    expect(out).not.toContain("1 create"); // bucket must not have become a spurious pass/fail signal here
  });

  test("multiple scenarios: overall exit reflects any failure, and every scenario is reported", async () => {
    const fixturePath = await writeFixture(snap({ resources: { bucket: meta() } }));
    const passing = Scenario("passing", { given: snapshot(fixturePath), expect: { noop: true } });
    const failing = Scenario("failing", { given: snapshot(fixturePath), expect: { create: 5 } });
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }, { passing, failing }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    const out = combined();
    expect(out).toContain("passing");
    expect(out).toContain("failing");
    expect(out).toContain("1/2 scenario(s) failed");
  });

  test("--json emits every scenario's verdict as structured data", async () => {
    const fixturePath = await writeFixture(snap({ resources: { bucket: meta() } }));
    const scenario = Scenario("plan-neutral", { given: snapshot(fixturePath), expect: { noop: true } });
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }, { plan: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs({ json: true }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const parsed = JSON.parse(stdoutBuf[0]);
    expect(parsed).toEqual([{ name: "plan-neutral", entity: "plan", env: "prod", pass: true, checks: [{ clause: "noop", pass: true }] }]);
  });
});

describe("runScenarioUnknown", () => {
  test("reports the unknown subcommand and exits 1", async () => {
    const stderrBuf: string[] = [];
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    const exit = await runScenarioUnknown({ args: makeArgs({ path: "bogus" }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderrBuf.join("\n")).toContain("bogus");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fixture-driven integration test (#1292): a tiny declared project + a
// committed fixture snapshot. Exercises the real path end to end — factory,
// evaluator, and the CLI handler's fixture replay — with no mocked fixture
// I/O: the JSON file is written to disk and read back for real.
// ─────────────────────────────────────────────────────────────────────────
describe("fixture-driven integration", () => {
  let stdoutBuf: string[];
  let dir: string;

  beforeEach(async () => {
    stdoutBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    buildMock.mockReset();
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: { environments: [{ name: "prod" }] } });
    dir = await mkdtemp(join(tmpdir(), "chant-scenario-integration-"));
    await writeFile(
      join(dir, "prod-baseline.json"),
      JSON.stringify(
        snap({
          resources: {
            webBucket: meta({ type: "AWS::S3::Bucket", physicalId: "arn:aws:s3:::web" }),
          },
        }),
      ),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the committed fixture: the declared project as-is is plan-neutral", async () => {
    const fixturePath = join(dir, "prod-baseline.json");
    const scenario = Scenario("web stack is plan-neutral", { given: snapshot(fixturePath), expect: { noop: true } });
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["webBucket"] }, { neutralityCheck: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(stdoutBuf.join("\n")).toContain("PASS");
  });

  test("dropping the declaration from source, against the same fixture, fails the scenario with a legible diff naming the resource", async () => {
    const fixturePath = join(dir, "prod-baseline.json");
    const scenario = Scenario("web stack is plan-neutral", { given: snapshot(fixturePath), expect: { noop: true } });
    // The mutation: webBucket no longer declared (dropped from source), same
    // committed fixture. The fixture still remembers it as owned+live, so the
    // plan now proposes deleting it — exactly the silent-delete the issue
    // describes chant having no way to catch today.
    buildMock.mockResolvedValue(makeBuildResult({}, { neutralityCheck: scenario }));

    const exit = await runScenarioCheck({ args: makeArgs(), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("FAIL");
    expect(out).toContain("noop:");
    expect(out).toContain("1 delete");
    expect(out).toContain("webBucket");
  });
});
