import { describe, test, expect } from "vitest";
import { toMermaid } from "./graph-mermaid";
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

describe("toMermaid", () => {
  test("renders a flowchart with lexicon subgraphs, nodes, and labelled edges", () => {
    const out = toMermaid(ir);
    expect(out).toContain("flowchart TD");
    expect(out).toContain('subgraph lex_gcp["gcp"]');
    expect(out).toContain('subgraph lex_k8s["k8s"]');
    // node label = name + kind on two lines
    expect(out).toContain('vpc["vpc<br/>Vpc"]');
    // edge with consumer-property label
    expect(out).toContain("subnet -->|\"network\"| vpc");
    // T3 edge shows consumer → producer attribute
    expect(out).toContain('ns -->|"subnet → selfLink"| subnet');
  });

  test("is deterministic", () => {
    expect(toMermaid(ir)).toEqual(toMermaid(ir));
  });

  test("sanitizes ids that aren't Mermaid-safe but keeps the human label", () => {
    const dirty: GraphIR = {
      nodes: [
        { id: "east/db-0", kind: "StatefulSet", lexicon: "k8s", attrs: {} },
        { id: "east/db-1", kind: "StatefulSet", lexicon: "k8s", attrs: {} },
      ],
      edges: [{ from: "east/db-1", to: "east/db-0", kind: "ref" }],
      groups: {},
    };
    const out = toMermaid(dirty);
    // ids are sanitized and unique
    expect(out).toContain('east_db_0["east/db-0<br/>StatefulSet"]');
    expect(out).toContain('east_db_1["east/db-1<br/>StatefulSet"]');
    expect(out).toContain("east_db_1 --> east_db_0");
  });

  test("places ungrouped nodes at the top level", () => {
    const out = toMermaid({
      nodes: [{ id: "loner", kind: "Thing", lexicon: "x", attrs: {} }],
      edges: [],
      groups: {},
    });
    expect(out).toContain('loner["loner<br/>Thing"]');
    expect(out).not.toContain("subgraph");
  });
});
