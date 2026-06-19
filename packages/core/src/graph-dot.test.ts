import { describe, test, expect } from "vitest";
import { toDot } from "./graph-dot";
import { parseDotJson } from "./graph-layout";
import type { GraphIR } from "./graph-ir";

const ir: GraphIR = {
  nodes: [
    { id: "vpc", kind: "Vpc", lexicon: "gcp", attrs: {} },
    { id: "subnet", kind: "Subnet", lexicon: "gcp", attrs: {} },
    { id: "ns", kind: "Namespace", lexicon: "k8s", attrs: {} },
  ],
  edges: [
    { from: "subnet", to: "vpc", kind: "ref", viaAttr: "network" },
    { from: "ns", to: "subnet", kind: "ref", viaAttr: "subnet", toAttr: "selfLink" },
  ],
  groups: { byLexicon: { gcp: ["subnet", "vpc"], k8s: ["ns"] } },
};

describe("toDot", () => {
  test("emits a digraph with lexicon clusters, nodes, and labelled edges", () => {
    const dot = toDot(ir);
    expect(dot).toContain("digraph chant {");
    expect(dot).toContain('subgraph "cluster_gcp" {');
    expect(dot).toContain('label="gcp";');
    expect(dot).toContain('"vpc" [label="vpc\\nVpc"];');
    expect(dot).toContain('"subnet" -> "vpc" [label="network"];');
    expect(dot).toContain('"ns" -> "subnet" [label="subnet → selfLink"];');
  });

  test("is deterministic", () => {
    expect(toDot(ir)).toEqual(toDot(ir));
  });

  test("places ungrouped nodes at the top level", () => {
    const dot = toDot({
      nodes: [{ id: "loner", kind: "Thing", lexicon: "x", attrs: {} }],
      edges: [],
      groups: {},
    });
    expect(dot).toContain('"loner" [label="loner\\nThing"];');
    expect(dot).not.toContain("subgraph");
  });
});

describe("parseDotJson", () => {
  test("parses bounding box and node positions, sorted by id", () => {
    const json = JSON.stringify({
      bb: "0,0,200,300",
      objects: [
        { name: "vpc", pos: "100,280" },
        { name: "subnet", pos: "100,20" },
      ],
    });
    const layout = parseDotJson(json);
    expect(layout).toEqual({
      width: 200,
      height: 300,
      nodes: [
        { id: "subnet", x: 100, y: 20 },
        { id: "vpc", x: 100, y: 280 },
      ],
    });
  });

  test("throws on a malformed bounding box", () => {
    expect(() => parseDotJson(JSON.stringify({ bb: "0,0", objects: [] }))).toThrow();
  });
});
