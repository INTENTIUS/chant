import { describe, test, expect } from "vitest";
import { parseLens, applyLens } from "./graph-lens";
import type { GraphIR } from "./graph-ir";

// vpc <- subnet <- cluster (gcp), cluster <- pod (k8s). A linear dependency
// chain crossing two lexicons.
const ir: GraphIR = {
  nodes: [
    { id: "vpc", kind: "Vpc", lexicon: "gcp", attrs: {} },
    { id: "subnet", kind: "Subnet", lexicon: "gcp", attrs: {} },
    { id: "cluster", kind: "GkeCluster", lexicon: "gcp", attrs: {} },
    { id: "pod", kind: "Pod", lexicon: "k8s", attrs: {} },
  ],
  edges: [
    { from: "subnet", to: "vpc", kind: "ref", viaAttr: "network" },
    { from: "cluster", to: "subnet", kind: "ref", viaAttr: "subnetwork" },
    { from: "pod", to: "cluster", kind: "ref", viaAttr: "cluster" },
  ],
  groups: { byLexicon: { gcp: ["cluster", "subnet", "vpc"], k8s: ["pod"] } },
};

describe("parseLens", () => {
  test("parses kind:target", () => {
    expect(parseLens("lexicon:gcp")).toMatchObject({ kind: "lexicon", target: "gcp" });
  });
  test("blast defaults to both directions", () => {
    expect(parseLens("blast:cluster")).toMatchObject({ up: true, down: true });
  });
  test("blast honours --up / --down", () => {
    expect(parseLens("blast:cluster", { up: true })).toMatchObject({ up: true, down: false });
  });
  test("rejects malformed and unknown lenses", () => {
    expect(() => parseLens("gcp")).toThrow();
    expect(() => parseLens("bogus:x")).toThrow();
  });
});

describe("applyLens", () => {
  test("lexicon: keeps only that lexicon's nodes and internal edges", () => {
    const out = applyLens(ir, parseLens("lexicon:gcp"));
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["cluster", "subnet", "vpc"]);
    // cross-lexicon pod→cluster edge dropped; gcp-internal edges kept
    expect(out.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "cluster->subnet",
      "subnet->vpc",
    ]);
    expect(out.groups.byLexicon).toEqual({ gcp: ["cluster", "subnet", "vpc"] });
  });

  test("lexicon: count matches the byLexicon partition", () => {
    const out = applyLens(ir, parseLens("lexicon:gcp"));
    expect(out.nodes.length).toBe(ir.groups.byLexicon!.gcp.length);
  });

  test("blast --up returns the producer chain above a node", () => {
    const out = applyLens(ir, parseLens("blast:cluster", { up: true }));
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["cluster", "subnet", "vpc"]);
  });

  test("blast --down returns the dependents below a node", () => {
    const out = applyLens(ir, parseLens("blast:cluster", { down: true }));
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["cluster", "pod"]);
  });

  test("blast both returns the whole connected chain", () => {
    const out = applyLens(ir, parseLens("blast:cluster"));
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["cluster", "pod", "subnet", "vpc"]);
  });

  test("blast on a leaf returns just its chain", () => {
    const out = applyLens(ir, parseLens("blast:vpc", { up: true }));
    expect(out.nodes.map((n) => n.id)).toEqual(["vpc"]); // vpc depends on nothing
    expect(out.edges).toEqual([]);
  });

  test("throws when the target matches nothing", () => {
    expect(() => applyLens(ir, parseLens("lexicon:aws"))).toThrow();
    expect(() => applyLens(ir, parseLens("blast:ghost"))).toThrow();
  });
});
