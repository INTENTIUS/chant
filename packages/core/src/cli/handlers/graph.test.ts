import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ParsedArgs } from "../registry";
import { DECLARABLE_MARKER, type Declarable } from "../../declarable";
import { AttrRef } from "../../attrref";

const discoverOpsMock = vi.fn();
vi.mock("../../op/discover", () => ({
  discoverOps: () => discoverOpsMock(),
}));

const discoverMock = vi.fn();
vi.mock("../../discovery/index", () => ({
  discover: () => discoverMock(),
}));

const lintMock = vi.fn();
vi.mock("../commands/lint", () => ({
  lintCommand: () => lintMock(),
}));

const componentGraphMock = vi.fn();
const generatePipelineMock = vi.fn();
vi.mock("../../components/cli-support", () => ({
  computeComponentGraph: () => componentGraphMock(),
  generateComponentsPipeline: (...a: unknown[]) => generatePipelineMock(...a),
}));

// Avoid running a real layout engine in tests; the format dispatch + size/engine
// plumbing is what matters here (engines have their own unit tests).
const layoutMock = vi.fn();
vi.mock("../../graph-layout", () => ({
  toLayoutInput: (ir: { nodes: { id: string }[] }, sizes: unknown) => ({ ir, sizes }),
  getLayoutEngine: (name?: string) => ({ name: name ?? "dagre", layout: (input: unknown) => layoutMock(input) }),
}));

// --live path deps. `graph` isn't `requiresPlugins`, so the live handler loads
// plugins itself; mock that plus observation/build/config (existing tests only
// hit the Op-graph and source-view modes, so these mocks don't touch them).
const loadPluginsMock = vi.fn();
const resolveLexMock = vi.fn();
vi.mock("../plugins", () => ({
  loadPlugins: (...a: unknown[]) => loadPluginsMock(...a),
  resolveProjectLexicons: (...a: unknown[]) => resolveLexMock(...a),
}));
const observeMock = vi.fn();
const replayMock = vi.fn();
const hasSnapshotMock = vi.fn((..._a: unknown[]) => Promise.resolve(false));
vi.mock("../../lifecycle/replay", () => ({
  replaySnapshots: (...a: unknown[]) => replayMock(...a),
  hasSnapshot: (...a: unknown[]) => hasSnapshotMock(...a),
}));

vi.mock("../../lifecycle/observe", () => ({
  observeResources: (...a: unknown[]) => observeMock(...a),
}));
// `runGraphLive` resolves each component's `cfn-deploy` stack(s) (#57) so a
// multi-stack, per-component project observes the right stacks; default to
// "no components" (empty map, no errors) so the existing single-stack --live
// test is unaffected unless a test opts into a component layout below.
const discoverComponentsMock = vi.fn();
vi.mock("../../components/discover", () => ({
  discoverComponents: (...a: unknown[]) => discoverComponentsMock(...a),
}));
const loadChantConfigMock = vi.fn();
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return {
    ...actual,
    loadChantConfig: (...a: unknown[]) => loadChantConfigMock(...a),
  };
});
vi.mock("../../build", () => ({
  build: () => Promise.resolve({ errors: [] }),
  partitionByLexicon: () => ({}),
  computeStackGraph: () => ({}),
}));

const { runGraph } = await import("./graph");

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "graph", path: ".",
    format: "", fix: false, watch: false, verbose: false, help: false, live: false,
    ...overrides,
  };
}

function makeOp(name: string, depends: string[] = []): [string, { config: { name: string; depends?: string[] } }] {
  return [name, { config: { name, depends } }];
}

function decl<T extends object>(base: T): Declarable & T {
  return { [DECLARABLE_MARKER]: true, ...base } as Declarable & T;
}

/** A small two-lexicon graph: vpc <- subnet (gcp), subnet <- pod (k8s). */
function sampleEntities(): Map<string, Declarable> {
  const vpc = decl({ lexicon: "gcp", entityType: "Vpc" });
  const subnet = decl({ lexicon: "gcp", entityType: "Subnet", props: { network: new AttrRef(vpc, "id") } });
  const pod = decl({ lexicon: "k8s", entityType: "Pod", props: { net: new AttrRef(subnet, "id") } });
  return new Map<string, Declarable>([["vpc", vpc], ["subnet", subnet], ["pod", pod]]);
}

describe("runGraph", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    discoverOpsMock.mockReset();
    discoverMock.mockReset();
    lintMock.mockReset();
    layoutMock.mockReset();
    componentGraphMock.mockReset();
    generatePipelineMock.mockReset();
    discoverComponentsMock.mockReset();
    // Default: no components — the single-stack --live path most tests exercise.
    discoverComponentsMock.mockResolvedValue({ components: new Map(), sourceFiles: [], errors: [] });
    observeMock.mockReset();
    loadPluginsMock.mockReset();
    resolveLexMock.mockReset();
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
  });

  describe("Op graph (default)", () => {
    test("prints 'No Ops found' when discovery is empty", async () => {
      discoverOpsMock.mockResolvedValue({ ops: new Map(), errors: [] });
      const exit = await runGraph({ args: makeArgs(), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(stdoutBuf.join("\n")).toContain("No Ops found");
    });

    test("prints 'No Op dependencies' when ops have no depends", async () => {
      discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("solo")]), errors: [] });
      const exit = await runGraph({ args: makeArgs(), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(stdoutBuf.join("\n")).toContain("No Op dependencies");
    });

    test("prints `dep -> name` edge per dependency", async () => {
      discoverOpsMock.mockResolvedValue({
        ops: new Map([makeOp("infra"), makeOp("app", ["infra"])]),
        errors: [],
      });
      const exit = await runGraph({ args: makeArgs(), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(stdoutBuf.join("\n")).toContain("infra → app");
    });

    test("handles multi-edge graphs", async () => {
      discoverOpsMock.mockResolvedValue({
        ops: new Map([makeOp("a"), makeOp("b", ["a"]), makeOp("c", ["a", "b"])]),
        errors: [],
      });
      await runGraph({ args: makeArgs(), plugins: [], serializers: [] });
      const out = stdoutBuf.join("\n");
      expect(out).toContain("a → b");
      expect(out).toContain("a → c");
      expect(out).toContain("b → c");
    });

    test("forwards discovery errors to stderr", async () => {
      discoverOpsMock.mockResolvedValue({ ops: new Map(), errors: ["failed to parse ops/bad.op.ts"] });
      const exit = await runGraph({ args: makeArgs(), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(stderrBuf.join("\n")).toContain("failed to parse ops/bad.op.ts");
    });
  });

  describe("graph IR views (--format ir|mermaid|dot|layout)", () => {
    const lintClean = (): void => { lintMock.mockResolvedValue({ success: true }); };
    const discovered = (): void => {
      discoverMock.mockResolvedValue({ entities: sampleEntities(), errors: [], dependencies: new Map(), sourceFiles: [] });
    };

    test("--format ir emits the graph IR as JSON", async () => {
      lintClean(); discovered();
      const exit = await runGraph({ args: makeArgs({ format: "ir" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      const ir = JSON.parse(stdoutBuf.join("\n"));
      expect(ir.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["pod", "subnet", "vpc"]);
      expect(ir.edges).toContainEqual({ from: "subnet", to: "vpc", kind: "ref", viaAttr: "network" });
    });

    test("lint gate: refuses to emit when source has lint errors", async () => {
      lintMock.mockResolvedValue({ success: false });
      const exit = await runGraph({ args: makeArgs({ format: "ir" }), plugins: [], serializers: [] });
      expect(exit).toBe(1);
      expect(stdoutBuf.join("\n")).toBe("");
      expect(stderrBuf.join("\n")).toMatch(/lint errors/i);
      expect(discoverMock).not.toHaveBeenCalled();
    });

    test("--format mermaid emits a flowchart", async () => {
      lintClean(); discovered();
      const exit = await runGraph({ args: makeArgs({ format: "mermaid" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(stdoutBuf.join("\n")).toContain("flowchart TD");
    });

    test("--format dot emits a digraph", async () => {
      lintClean(); discovered();
      const exit = await runGraph({ args: makeArgs({ format: "dot" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(stdoutBuf.join("\n")).toContain("digraph chant {");
    });

    test("--format layout emits positions from the layout engine", async () => {
      lintClean(); discovered();
      layoutMock.mockResolvedValue({ width: 100, height: 50, nodes: [{ id: "vpc", x: 1, y: 2 }] });
      const exit = await runGraph({ args: makeArgs({ format: "layout" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(JSON.parse(stdoutBuf.join("\n"))).toMatchObject({ width: 100, nodes: [{ id: "vpc", x: 1, y: 2 }] });
    });

    test("--format layout reports a clear error when the engine fails (e.g. dot missing)", async () => {
      lintClean(); discovered();
      layoutMock.mockRejectedValue(new Error("could not run 'dot'"));
      const exit = await runGraph({ args: makeArgs({ format: "layout" }), plugins: [], serializers: [] });
      expect(exit).toBe(1);
      expect(stderrBuf.join("\n")).toContain("could not run 'dot'");
    });

    test("--detail 0 collapses to one node per lexicon", async () => {
      lintClean(); discovered();
      const exit = await runGraph({ args: makeArgs({ format: "ir", detail: 0 }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      const ir = JSON.parse(stdoutBuf.join("\n"));
      expect(ir.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["gcp", "k8s"]);
    });

    test("rejects an out-of-range --detail", async () => {
      const exit = await runGraph({ args: makeArgs({ format: "ir", detail: 9 }), plugins: [], serializers: [] });
      expect(exit).toBe(1);
      expect(stderrBuf.join("\n")).toMatch(/detail/i);
      expect(lintMock).not.toHaveBeenCalled();
    });

    test("--lens lexicon:gcp filters to that lexicon", async () => {
      lintClean(); discovered();
      const exit = await runGraph({ args: makeArgs({ format: "ir", lens: "lexicon:gcp" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      const ir = JSON.parse(stdoutBuf.join("\n"));
      expect(ir.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["subnet", "vpc"]);
    });

    test("--lens with a bad spec errors out", async () => {
      lintClean(); discovered();
      const exit = await runGraph({ args: makeArgs({ format: "ir", lens: "nope" }), plugins: [], serializers: [] });
      expect(exit).toBe(1);
      expect(stderrBuf.join("\n")).toMatch(/lens/i);
    });

    test("--format ir forwards discovery errors and exits non-zero", async () => {
      lintClean();
      discoverMock.mockResolvedValue({ entities: new Map(), errors: [{ message: "boom" }], dependencies: new Map(), sourceFiles: [] });
      const exit = await runGraph({ args: makeArgs({ format: "ir" }), plugins: [], serializers: [] });
      expect(exit).toBe(1);
      expect(stderrBuf.join("\n")).toContain("boom");
    });
  });

  describe("component DAG view (--components --format ir|layout)", () => {
    // shared-foundation (wave 1) <- loom-db (wave 2) <- loom-backend (wave 3).
    const componentGraphClean = (): void => {
      componentGraphMock.mockResolvedValue({
        success: true,
        order: ["shared-foundation", "loom-db", "loom-backend"],
        waves: [["shared-foundation"], ["loom-db"], ["loom-backend"]],
        edges: [
          { from: "loom-db", to: "shared-foundation" },
          { from: "loom-backend", to: "loom-db" },
        ],
        files: {
          "shared-foundation": "components/shared-foundation.component.ts",
          "loom-db": "components/loom-db.component.ts",
          "loom-backend": "components/loom-backend.component.ts",
        },
      });
    };

    test("--components --format ir emits component nodes, byWave groups, and dependsOn edges", async () => {
      lintMock.mockResolvedValue({ success: true });
      componentGraphClean();
      const exit = await runGraph({ args: makeArgs({ format: "ir", components: true }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      const ir = JSON.parse(stdoutBuf.join("\n"));
      // One node per component (not per resource); wave carried on the node.
      expect(ir.nodes.map((n: { id: string }) => n.id)).toEqual(["shared-foundation", "loom-db", "loom-backend"]);
      expect(ir.nodes.every((n: { kind: string; lexicon: string }) => n.kind === "Component" && n.lexicon === "chant")).toBe(true);
      expect(ir.nodes.find((n: { id: string }) => n.id === "loom-backend").attrs.wave).toBe(3);
      // Each component node deep-links to its source file.
      expect(ir.nodes.find((n: { id: string }) => n.id === "loom-db").sourceLoc).toEqual({
        file: "components/loom-db.component.ts",
      });
      // dependsOn edges, consumer → producer.
      expect(ir.edges).toContainEqual({ from: "loom-db", to: "shared-foundation", kind: "ref" });
      // Waves as groups.
      expect(ir.groups.byWave).toEqual({
        "wave-1": ["shared-foundation"],
        "wave-2": ["loom-db"],
        "wave-3": ["loom-backend"],
      });
      // The entity-graph discovery path is not taken for the component projection.
      expect(discoverMock).not.toHaveBeenCalled();
    });

    test("--components --format mermaid lanes the components by wave", async () => {
      lintMock.mockResolvedValue({ success: true });
      componentGraphClean();
      const exit = await runGraph({ args: makeArgs({ format: "mermaid", components: true }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      const out = stdoutBuf.join("\n");
      expect(out).toContain("flowchart TD");
      expect(out).toContain("wave-1");
    });

    test("--components view is lint-gated like the entity view", async () => {
      lintMock.mockResolvedValue({ success: false });
      const exit = await runGraph({ args: makeArgs({ format: "ir", components: true }), plugins: [], serializers: [] });
      expect(exit).toBe(1);
      expect(stdoutBuf.join("\n")).toBe("");
      expect(stderrBuf.join("\n")).toMatch(/lint errors/i);
      expect(componentGraphMock).not.toHaveBeenCalled();
    });

    test("propagates a component-graph failure (unknown dep / cycle) as a non-zero exit", async () => {
      lintMock.mockResolvedValue({ success: true });
      componentGraphMock.mockResolvedValue({ success: false, order: [], waves: [], edges: [], error: "cycle: a ↔ b" });
      const exit = await runGraph({ args: makeArgs({ format: "ir", components: true }), plugins: [], serializers: [] });
      expect(exit).toBe(1);
      expect(stderrBuf.join("\n")).toContain("cycle: a ↔ b");
    });

    describe("CI/pipeline projection (--projection, #989)", () => {
      test("rejects --projection without --components --format ir", async () => {
        const exit = await runGraph({ args: makeArgs({ projection: "gitlab" }), plugins: [], serializers: [] });
        expect(exit).toBe(1);
        expect(stderrBuf.join("\n")).toMatch(/--projection needs --components --format ir/);
        expect(componentGraphMock).not.toHaveBeenCalled();
      });

      test("rejects --projection with --components --format mermaid", async () => {
        const exit = await runGraph({
          args: makeArgs({ projection: "gitlab", components: true, format: "mermaid" }),
          plugins: [],
          serializers: [],
        });
        expect(exit).toBe(1);
        expect(stderrBuf.join("\n")).toMatch(/--projection needs --components --format ir/);
      });

      test("--components --format ir --projection gitlab adds ir.pipeline, reusing generateComponentsPipeline", async () => {
        lintMock.mockResolvedValue({ success: true });
        componentGraphClean();
        generatePipelineMock.mockResolvedValue({
          success: true,
          stages: ["wave-1", "wave-2", "wave-3"],
          jobs: [
            { jobName: "shared-foundation", component: "shared-foundation", stage: "wave-1", needs: [] },
            { jobName: "loom-db", component: "loom-db", stage: "wave-2", needs: ["shared-foundation"] },
            { jobName: "loom-backend", component: "loom-backend", stage: "wave-3", needs: ["loom-db"] },
          ],
          yaml: "stages: [...]\n",
        });

        const exit = await runGraph({
          args: makeArgs({ format: "ir", components: true, projection: "gitlab" }),
          plugins: [],
          serializers: [],
        });
        expect(exit).toBe(0);

        // Reuses the same generator `build --components --generate` calls —
        // never re-derives stages/jobs/needs itself.
        expect(generatePipelineMock).toHaveBeenCalledWith(expect.any(String), "gitlab", undefined, undefined);

        const ir = JSON.parse(stdoutBuf.join("\n"));
        // The component graph itself is untouched by the projection.
        expect(ir.nodes.map((n: { id: string }) => n.id)).toEqual(["shared-foundation", "loom-db", "loom-backend"]);
        expect(ir.groups.byWave["wave-2"]).toEqual(["loom-db"]);

        // The CI/pipeline projection sits alongside it as first-class IR nodes/edges.
        expect(ir.pipeline.provider).toBe("gitlab");
        expect(ir.pipeline.stages).toEqual(["wave-1", "wave-2", "wave-3"]);
        expect(ir.pipeline.nodes).toEqual([
          { id: "shared-foundation", kind: "CIJob", component: "shared-foundation", stage: "wave-1" },
          { id: "loom-db", kind: "CIJob", component: "loom-db", stage: "wave-2" },
          { id: "loom-backend", kind: "CIJob", component: "loom-backend", stage: "wave-3" },
        ]);
        // `needs:` edges, consumer job → producer job (mirrors the component
        // graph's consumer → producer convention).
        expect(ir.pipeline.edges).toEqual([
          { from: "loom-db", to: "shared-foundation", kind: "needs" },
          { from: "loom-backend", to: "loom-db", kind: "needs" },
        ]);
      });

      test("an unsupported --projection lexicon fails the whole graph command", async () => {
        lintMock.mockResolvedValue({ success: true });
        componentGraphClean();
        generatePipelineMock.mockResolvedValue({
          success: false,
          error: 'Lexicon "bogus" does not support generate mode (no generateComponentPipeline).',
        });

        const exit = await runGraph({
          args: makeArgs({ format: "ir", components: true, projection: "bogus" }),
          plugins: [],
          serializers: [],
        });
        expect(exit).toBe(1);
        expect(stderrBuf.join("\n")).toContain("does not support generate mode");
        expect(stdoutBuf.join("\n")).toBe("");
      });
    });
  });

  describe("live graph (--live)", () => {
    // Regression: `graph` is not `requiresPlugins`, so `ctx.plugins` is empty. The
    // live path must load the project's plugins itself — otherwise it wrongly
    // reports "No lexicons implement describeResources" and observes nothing.
    test("loads plugins for --live when ctx.plugins is empty", async () => {
      resolveLexMock.mockResolvedValue(["aws"]);
      loadPluginsMock.mockResolvedValue([
        { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}) },
      ]);
      observeMock.mockResolvedValue({
        observations: [{ lexicon: "aws", resources: { "web-vpc": { type: "AWS::EC2::VPC", status: "OK" } } }],
        errors: [],
        warnings: [],
      });
      const exit = await runGraph({ args: makeArgs({ format: "ir", live: true, env: "prod" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(loadPluginsMock).toHaveBeenCalled();
      const out = stdoutBuf.join("\n");
      expect(out).not.toContain("No lexicons implement describeResources");
      expect(out).toContain("web-vpc");
    });

    // #1279 — `graph` had no `--at`, so anyone wanting the raw IR of a recorded
    // estate had to reach for the live endpoint. A snapshot could answer most
    // questions and never all of them.
    test("--at graphs the recorded snapshot without reading the estate", async () => {
      resolveLexMock.mockResolvedValue(["aws"]);
      loadPluginsMock.mockResolvedValue([
        { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}),
          enrichLiveAttrs: () => Promise.reject(new Error("must not be called on a replay")) },
      ]);
      replayMock.mockResolvedValue({
        observations: [{ lexicon: "aws", resources: {
          web: { type: "AWS::EC2::Instance", status: "OBSERVED", physicalId: "i-1" },
        } }],
        commit: "abc1234def",
        timestamp: "2026-07-31T00:00:00.000Z",
      });
      const exit = await runGraph({ args: makeArgs({ format: "ir", at: "latest", env: "prod" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(observeMock).not.toHaveBeenCalled();
      expect(replayMock).toHaveBeenCalled();
      expect(stdoutBuf.join("\n")).toContain("i-1");
    });

    // Denied the network, agents read the empty graph as an empty estate and
    // spent their turns retrying --live. The per-entity warnings describe the
    // same failure N times and never name the thing that would answer.
    test("an unreadable estate names the recorded snapshot", async () => {
      observeMock.mockClear();
      hasSnapshotMock.mockResolvedValue(true);
      resolveLexMock.mockResolvedValue(["aws"]);
      loadPluginsMock.mockResolvedValue([
        { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}) },
      ]);
      observeMock.mockResolvedValue({ observations: [], errors: ["could not connect"], warnings: [] });
      const errs: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((s: string) => { errs.push(s); });
      await runGraph({ args: makeArgs({ format: "ir", live: true, env: "prod" }), plugins: [], serializers: [] });
      spy.mockRestore();
      hasSnapshotMock.mockResolvedValue(false);
      expect(errs.join("\n")).toContain("--at latest");
    });

    test("says nothing about a snapshot when there is none to name", async () => {
      observeMock.mockClear();
      hasSnapshotMock.mockResolvedValue(false);
      resolveLexMock.mockResolvedValue(["aws"]);
      loadPluginsMock.mockResolvedValue([
        { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}) },
      ]);
      observeMock.mockResolvedValue({ observations: [], errors: ["could not connect"], warnings: [] });
      const errs: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((s: string) => { errs.push(s); });
      await runGraph({ args: makeArgs({ format: "ir", live: true, env: "prod" }), plugins: [], serializers: [] });
      spy.mockRestore();
      expect(errs.join("\n")).not.toContain("--at latest");
    });

    test("--at and --live together is refused rather than guessed at", async () => {
      observeMock.mockClear();
      replayMock.mockClear();
      resolveLexMock.mockResolvedValue(["aws"]);
      const exit = await runGraph({ args: makeArgs({ format: "ir", at: "latest", live: true, env: "prod" }), plugins: [], serializers: [] });
      expect(exit).toBe(1);
      expect(observeMock).not.toHaveBeenCalled();
      expect(replayMock).not.toHaveBeenCalled();
    });

    // Regression for #57: a single-stack project (no `*.component.ts` files —
    // discoverComponents returns an empty map) must observe exactly as before,
    // no `stacks` collected.
    test("single-stack project (no components): observeResources gets an empty stacks list", async () => {
      resolveLexMock.mockResolvedValue(["aws"]);
      loadPluginsMock.mockResolvedValue([
        { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}) },
      ]);
      observeMock.mockResolvedValue({ observations: [], errors: [], warnings: [] });
      const exit = await runGraph({ args: makeArgs({ format: "ir", live: true, env: "prod" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(observeMock).toHaveBeenCalledWith("prod", expect.anything(), expect.anything(), {
        owned: true,
        stacks: [],
      });
    });

    // The bug this branch fixes (#57): a multi-stack, per-component project
    // (loomster/Floci) has no stack literally named after the environment, so
    // the live graph must resolve each component's own `cfn-deploy` stack(s)
    // and pass them through to `observeResources` for the per-stack union.
    test("multi-stack component project: resolves each component's cfn-deploy stack(s) and passes them to observeResources", async () => {
      resolveLexMock.mockResolvedValue(["aws"]);
      loadPluginsMock.mockResolvedValue([
        { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}) },
      ]);
      discoverComponentsMock.mockResolvedValue({
        errors: [],
        sourceFiles: [],
        components: new Map([
          ["loom-db", { component: { name: "loom-db", dependsOn: [], deploy: [
            { phase: "deploy", steps: [{ kind: "cfn-deploy", stack: "loom-local-a-loom-db" }] },
          ] }, exportName: "loomDb", filePath: "components/loom-db.component.ts" }],
          // Multi-stack component: two cfn-deploy steps, nested under a sub-phase.
          ["loom-backend", { component: { name: "loom-backend", dependsOn: ["loom-db"], deploy: [
            { phase: "deploy", steps: [
              { phase: "nested", steps: [{ kind: "cfn-deploy", stack: "loom-local-a-loom-backend" }] },
              { kind: "cfn-deploy", stack: "loom-local-a-loom-backend-jobs" },
            ] },
          ] }, exportName: "loomBackend", filePath: "components/loom-backend.component.ts" }],
          // Non-aws / no cfn-deploy component: contributes no stacks.
          ["loom-frontend", { component: { name: "loom-frontend", dependsOn: [], deploy: [
            { phase: "deploy", steps: [{ kind: "s3-sync" }] },
          ] }, exportName: "loomFrontend", filePath: "components/loom-frontend.component.ts" }],
        ]),
      });
      observeMock.mockResolvedValue({
        observations: [{ lexicon: "aws", resources: { "loom-db": { type: "AWS::RDS::DBInstance", status: "OK" } } }],
        errors: [],
        warnings: [],
      });
      const exit = await runGraph({ args: makeArgs({ format: "ir", live: true, env: "local" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(observeMock).toHaveBeenCalledTimes(1);
      const [, , , opts] = observeMock.mock.calls[0];
      expect((opts as { stacks: Array<{name:string}> }).stacks.map((x)=>x.name).sort()).toEqual([
        "loom-local-a-loom-backend",
        "loom-local-a-loom-backend-jobs",
        "loom-local-a-loom-db",
      ]);
      expect((opts as { owned: boolean }).owned).toBe(true);
    });

    // #1158: a project that declares its stacks in `ChantConfig.stacks` — rather
    // than deriving them from `*.component.ts` — must observe each declared
    // stack, the same contract `resolveStackTargets` gives lifecycle
    // snapshot/diff. Every other test here passes `stacks: []`, so without this
    // the declared-stack path is implemented and unguarded.
    test("ChantConfig.stacks: observeResources gets every declared stack, with its region and src", async () => {
      resolveLexMock.mockResolvedValue(["aws"]);
      loadPluginsMock.mockResolvedValue([
        { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}) },
      ]);
      loadChantConfigMock.mockResolvedValue({
        config: {
          stacks: [
            { name: "estate-east", region: "us-east-1", src: "east/src" },
            { name: "estate-west", region: "us-west-2", src: "west/src" },
          ],
        },
      });
      observeMock.mockResolvedValue({ observations: [], errors: [], warnings: [] });
      const exit = await runGraph({ args: makeArgs({ format: "ir", live: true, env: "prod" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(observeMock).toHaveBeenCalledTimes(1);
      const [, , , opts] = observeMock.mock.calls[0];
      // The region/src carry through — a multi-region estate observes each
      // stack in its own region, not all of them in the ambient default.
      expect((opts as { stacks: Array<{ name: string; region?: string; src?: string }> }).stacks).toEqual([
        { name: "estate-east", region: "us-east-1", src: "east/src" },
        { name: "estate-west", region: "us-west-2", src: "west/src" },
      ]);
    });

    // A stack can be both component-derived and declared. It must be observed
    // once — `describeResources` is a live API call per stack, so a duplicate
    // is a wasted round trip and a doubled node set to reconcile.
    test("ChantConfig.stacks: a stack also derived from a component is not observed twice", async () => {
      resolveLexMock.mockResolvedValue(["aws"]);
      loadPluginsMock.mockResolvedValue([
        { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}) },
      ]);
      discoverComponentsMock.mockResolvedValue({
        errors: [],
        sourceFiles: [],
        components: new Map([
          ["loom-db", { component: { name: "loom-db", dependsOn: [], deploy: [
            { phase: "deploy", steps: [{ kind: "cfn-deploy", stack: "shared-estate" }] },
          ] }, exportName: "loomDb", filePath: "components/loom-db.component.ts" }],
        ]),
      });
      loadChantConfigMock.mockResolvedValue({
        config: { stacks: [{ name: "shared-estate" }, { name: "estate-west" }] },
      });
      observeMock.mockResolvedValue({ observations: [], errors: [], warnings: [] });
      const exit = await runGraph({ args: makeArgs({ format: "ir", live: true, env: "prod" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      const [, , , opts] = observeMock.mock.calls[0];
      expect((opts as { stacks: Array<{ name: string }> }).stacks.map((s) => s.name)).toEqual([
        "shared-estate",
        "estate-west",
      ]);
    });

    test("component discovery errors: falls back to the single-stack path with a warning", async () => {
      resolveLexMock.mockResolvedValue(["aws"]);
      loadPluginsMock.mockResolvedValue([
        { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}) },
      ]);
      discoverComponentsMock.mockResolvedValue({ errors: [{ message: "bad component" }], sourceFiles: [], components: new Map() });
      observeMock.mockResolvedValue({ observations: [], errors: [], warnings: [] });
      const exit = await runGraph({ args: makeArgs({ format: "ir", live: true, env: "prod" }), plugins: [], serializers: [] });
      expect(exit).toBe(0);
      expect(observeMock).toHaveBeenCalledWith("prod", expect.anything(), expect.anything(), {
        owned: true,
        stacks: [],
      });
      expect(stderrBuf.join("\n")).toMatch(/component discovery failed/i);
    });

    // #1166 — an environment can declare its own endpoint (a local emulator
    // like Floci), so `--live --env floci` observes the right target even when
    // the ambient shell never exported AWS_ENDPOINT_URL.
    describe("declared endpoint (#1166)", () => {
      const prevEndpoint = process.env.AWS_ENDPOINT_URL;

      afterEach(() => {
        if (prevEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL;
        else process.env.AWS_ENDPOINT_URL = prevEndpoint;
      });

      test("applies the declared endpoint to AWS_ENDPOINT_URL for the observe call, then restores it", async () => {
        delete process.env.AWS_ENDPOINT_URL;
        loadChantConfigMock.mockResolvedValue({
          config: { environments: [{ name: "floci", endpoint: "http://localhost:4566" }] },
        });
        resolveLexMock.mockResolvedValue(["aws"]);
        loadPluginsMock.mockResolvedValue([
          { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}) },
        ]);
        let seenDuringObserve: string | undefined;
        observeMock.mockImplementation(async () => {
          seenDuringObserve = process.env.AWS_ENDPOINT_URL;
          return { observations: [], errors: [], warnings: [] };
        });
        const exit = await runGraph({ args: makeArgs({ format: "ir", live: true, env: "floci" }), plugins: [], serializers: [] });
        expect(exit).toBe(0);
        expect(seenDuringObserve).toBe("http://localhost:4566");
        expect(process.env.AWS_ENDPOINT_URL).toBeUndefined(); // restored after the read
        expect(stderrBuf.join("\n")).toMatch(/environment "floci" declares endpoint http:\/\/localhost:4566/);
      });

      test("ambient AWS_ENDPOINT_URL still wins when already set", async () => {
        process.env.AWS_ENDPOINT_URL = "http://real-endpoint.example";
        loadChantConfigMock.mockResolvedValue({
          config: { environments: [{ name: "floci", endpoint: "http://localhost:4566" }] },
        });
        resolveLexMock.mockResolvedValue(["aws"]);
        loadPluginsMock.mockResolvedValue([
          { name: "aws", serializer: {}, describeResources: () => Promise.resolve({}) },
        ]);
        let seenDuringObserve: string | undefined;
        observeMock.mockImplementation(async () => {
          seenDuringObserve = process.env.AWS_ENDPOINT_URL;
          return { observations: [], errors: [], warnings: [] };
        });
        const exit = await runGraph({ args: makeArgs({ format: "ir", live: true, env: "floci" }), plugins: [], serializers: [] });
        expect(exit).toBe(0);
        expect(seenDuringObserve).toBe("http://real-endpoint.example"); // ambient wins
        expect(process.env.AWS_ENDPOINT_URL).toBe("http://real-endpoint.example"); // untouched
        expect(stderrBuf.join("\n")).toMatch(/ambient AWS_ENDPOINT_URL already set/);
      });
    });
  });
});
