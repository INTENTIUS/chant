import { describe, test, expect } from "vitest";
import { applyLexiconGraphEdges, type GraphIR } from "./graph-ir";
import { toMermaid } from "./graph-mermaid";
import { toDot } from "./graph-dot";
import { applyDetail } from "./graph-detail";
import { applyLens, parseLens } from "./graph-lens";

// #3910: CI lexicons report their dependency strings through `graphEdges`, and
// core merges them, keeps the unresolved ones and draws both.

const base: GraphIR = {
  nodes: [
    { id: "ci", kind: "GitHub::Actions::Workflow", lexicon: "github", attrs: {} },
    { id: "build", kind: "GitHub::Actions::Job", lexicon: "github", attrs: {} },
    { id: "test", kind: "GitHub::Actions::Job", lexicon: "github", attrs: {} },
    { id: "shared", kind: "GitHub::Actions::Workflow", lexicon: "github", attrs: {} },
  ],
  // The core walk already found `test` holding the build Job under `needs`.
  edges: [{ from: "test", to: "build", kind: "ref", viaAttr: "needs" }],
  groups: { byLexicon: { github: ["build", "ci", "shared", "test"] } },
};

const merged = applyLexiconGraphEdges(base, [{
  references: [
    { from: "test", to: "build", kind: "needs", viaAttr: "needs" },
    { from: "test", to: "shared", kind: "calls", viaAttr: "uses", crossPipeline: true },
    { from: "test", to: "lint", kind: "needs", viaAttr: "needs", dangling: true },
    { from: "build", to: "nowhere", kind: "needs", viaAttr: "needs" },
    { from: "ghost", to: "build", kind: "needs" },
  ],
  pipelines: { ci: ["ci", "build", "test", "ghost"], shared: ["shared"] },
}]);

describe("applyLexiconGraphEdges (#3910)", () => {
  test("a lexicon edge replaces the core ref edge on the same from/to/viaAttr", () => {
    expect(merged.edges).toEqual([
      { from: "test", to: "build", kind: "needs", viaAttr: "needs" },
      { from: "test", to: "shared", kind: "calls", viaAttr: "uses", crossPipeline: true },
    ]);
  });

  test("a dangling reference, or one whose target is not a node, is kept on ir.dangling", () => {
    expect(merged.dangling).toEqual([
      { from: "build", kind: "needs", path: "needs", value: "nowhere" },
      { from: "test", kind: "needs", path: "needs", value: "lint" },
    ]);
  });

  test("pipelines land on groups.byPipeline, restricted to nodes", () => {
    expect(merged.groups.byPipeline).toEqual({ ci: ["build", "ci", "test"], shared: ["shared"] });
  });

  test("no report leaves the IR as it was", () => {
    expect(applyLexiconGraphEdges(base, [])).toBe(base);
    expect(applyLexiconGraphEdges(base, [{ references: [] }])).toBe(base);
  });
});

describe("renderers draw CI edges (#3910)", () => {
  test("mermaid: kind labels, dashed cross-pipeline edges, pipeline subgraphs, dangling stubs", () => {
    const out = toMermaid(merged);
    expect(out).toContain('test -->|"needs"| build');
    expect(out).toContain('test -.->|"calls (uses)"| shared');
    expect(out).toContain('subgraph pipe_github_ci["ci"]');
    expect(out).toContain('subgraph pipe_github_shared["shared"]');
    expect(out).toContain('dangling_lint(["lint<br/>(not declared)"])');
    expect(out).toContain('test -.->|"needs"| dangling_lint');
  });

  test("dot: the same, as nested clusters and dashed edges", () => {
    const out = toDot(merged);
    expect(out).toContain('"test" -> "build" [label="needs"];');
    expect(out).toContain('"test" -> "shared" [label="calls (uses)", style=dashed];');
    expect(out).toContain('subgraph "cluster_github_pipeline_ci" {');
    expect(out).toContain('"dangling:lint" [label="lint\\n(not declared)", shape=box, style="rounded,dashed"];');
    expect(out).toContain('"test" -> "dangling:lint" [label="needs", style=dashed];');
  });

  test("a typed ref edge renders as before", () => {
    const out = toMermaid({ ...base, edges: [{ from: "test", to: "build", kind: "ref", viaAttr: "needs" }] });
    expect(out).toContain('test -->|"needs"| build');
  });
});

describe("detail and lens keep CI edges (#3910)", () => {
  test("the composite tier keeps the kind and the cross-pipeline mark, and the dangling list", () => {
    const t1 = applyDetail(merged, 1);
    expect(t1.edges).toContainEqual({ from: "test", to: "shared", kind: "calls", viaAttr: "uses", crossPipeline: true });
    expect(t1.dangling).toHaveLength(2);
  });

  test("a lens keeps the dangling references and pipelines of the nodes it keeps", () => {
    const focused = applyLens(merged, parseLens("blast:shared", { down: true }));
    expect(focused.dangling).toEqual([{ from: "test", kind: "needs", path: "needs", value: "lint" }]);
    expect(focused.groups.byPipeline).toEqual({ ci: ["test"], shared: ["shared"] });
  });
});

describe("detail tiers carry groups.byPipeline (#3921)", () => {
  // `build` and `test` sit inside one composite instance; `lint` in another
  // that also holds a job of the `shared` pipeline.
  const composed: GraphIR = {
    nodes: [
      { id: "ci", kind: "GitHub::Actions::Workflow", lexicon: "github", attrs: {} },
      { id: "build", kind: "GitHub::Actions::Job", lexicon: "github", attrs: {}, compositeInstance: "pair", compositeParent: "Pair" },
      { id: "test", kind: "GitHub::Actions::Job", lexicon: "github", attrs: {}, compositeInstance: "pair", compositeParent: "Pair" },
      { id: "lint", kind: "GitHub::Actions::Job", lexicon: "github", attrs: {}, compositeInstance: "mixed", compositeParent: "Mixed" },
      { id: "publish", kind: "GitHub::Actions::Job", lexicon: "github", attrs: {}, compositeInstance: "mixed", compositeParent: "Mixed" },
      { id: "shared", kind: "GitHub::Actions::Workflow", lexicon: "github", attrs: {} },
    ],
    edges: [],
    groups: {
      byLexicon: { github: ["build", "ci", "lint", "publish", "shared", "test"] },
      byPipeline: { ci: ["build", "ci", "lint", "test"], shared: ["publish", "shared"], gone: ["ghost"] },
    },
  };

  test("the composite tier maps members to the composites that hold them, deduped", () => {
    expect(applyDetail(composed, 1).groups.byPipeline).toEqual({
      ci: ["ci", "mixed", "pair"],
      shared: ["mixed", "shared"],
    });
  });

  test("the composite tier keeps plain members as they are", () => {
    expect(applyDetail(merged, 1).groups.byPipeline).toEqual({ ci: ["build", "ci", "test"], shared: ["shared"] });
  });

  test("a pipeline with no kept member is dropped, and no pipelines means no byPipeline", () => {
    const none = applyDetail({ ...composed, groups: { byPipeline: { gone: ["ghost"] } } }, 1);
    expect(none.groups.byPipeline).toBeUndefined();
  });

  test("the stacks tier has no pipelines: each would hold only its lexicon's node", () => {
    expect(applyDetail(composed, 0).groups.byPipeline).toBeUndefined();
  });

  test("a lens then the composite tier keeps the pipelines of what survives", () => {
    const t1 = applyDetail(applyLens(composed, parseLens("blast:shared")), 1);
    expect(t1.groups.byPipeline).toEqual({ shared: ["shared"] });
  });

  test("declarable and attribute tiers pass byPipeline through", () => {
    expect(applyDetail(composed, 2).groups.byPipeline).toEqual(composed.groups.byPipeline);
    expect(applyDetail(composed, 3).groups.byPipeline).toEqual(composed.groups.byPipeline);
  });
});
