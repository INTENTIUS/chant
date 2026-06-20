import { describe, test, expect, vi, beforeEach } from "vitest";
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

// Avoid running a real layout engine in tests; the format dispatch + size/engine
// plumbing is what matters here (engines have their own unit tests).
const layoutMock = vi.fn();
vi.mock("../../graph-layout", () => ({
  toLayoutInput: (ir: { nodes: { id: string }[] }, sizes: unknown) => ({ ir, sizes }),
  getLayoutEngine: (name?: string) => ({ name: name ?? "dagre", layout: (input: unknown) => layoutMock(input) }),
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
});
