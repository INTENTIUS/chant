import { describe, test, expect } from "vitest";
import { applyDetail, DETAIL } from "./graph-detail";
import type { GraphIR } from "./graph-ir";

// A small graph: a gcp vpc/subnet pair plus a k8s namespace and deployment that
// came from one composite instance ("db"), with the deployment referencing the
// subnet across lexicons.
const base: GraphIR = {
  nodes: [
    { id: "vpc", kind: "Vpc", lexicon: "gcp", attrs: {} },
    { id: "subnet", kind: "Subnet", lexicon: "gcp", attrs: { network: { $ref: "vpc.id" } } },
    {
      id: "dbNamespace",
      kind: "Namespace",
      lexicon: "k8s",
      compositeParent: "DbStack",
      compositeInstance: "db",
      attrs: {},
    },
    {
      id: "dbDeployment",
      kind: "Deployment",
      lexicon: "k8s",
      compositeParent: "DbStack",
      compositeInstance: "db",
      attrs: { subnet: { $ref: "subnet.selfLink" } },
    },
  ],
  edges: [
    { from: "subnet", to: "vpc", kind: "ref", viaAttr: "network" },
    { from: "dbDeployment", to: "subnet", kind: "ref", viaAttr: "subnet" },
  ],
  groups: { byLexicon: { gcp: ["subnet", "vpc"], k8s: ["dbDeployment", "dbNamespace"] } },
};

describe("applyDetail", () => {
  test("T2 (declarables) is the identity", () => {
    expect(applyDetail(base, DETAIL.DECLARABLES)).toBe(base);
  });

  test("T0 (stacks) collapses to one node per lexicon with cross-lexicon edges", () => {
    const ir = applyDetail(base, DETAIL.STACKS);
    expect(ir.nodes.map((n) => n.id)).toEqual(["gcp", "k8s"]);
    expect(ir.nodes.every((n) => n.kind === "stack")).toBe(true);
    // subnet→vpc is intra-gcp (dropped); dbDeployment→subnet is k8s→gcp (kept).
    expect(ir.edges).toEqual([{ from: "k8s", to: "gcp", kind: "ref" }]);
  });

  test("T1 (composites) collapses a composite instance to a single node", () => {
    const ir = applyDetail(base, DETAIL.COMPOSITES);
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(["db", "subnet", "vpc"]);
    const db = ir.nodes.find((n) => n.id === "db")!;
    expect(db).toMatchObject({ kind: "DbStack", lexicon: "k8s", attrs: { members: 2 } });
    // The composite's external ref is preserved, remapped to the composite node.
    expect(ir.edges).toContainEqual({ from: "db", to: "subnet", kind: "ref" });
    // The intra-gcp edge survives with its label.
    expect(ir.edges).toContainEqual({ from: "subnet", to: "vpc", kind: "ref", viaAttr: "network" });
  });

  test("T1 node count is between T0 and T2", () => {
    const t0 = applyDetail(base, DETAIL.STACKS).nodes.length;
    const t1 = applyDetail(base, DETAIL.COMPOSITES).nodes.length;
    const t2 = applyDetail(base, DETAIL.DECLARABLES).nodes.length;
    expect(t0).toBeLessThan(t1);
    expect(t1).toBeLessThan(t2);
  });

  test("T3 (attributes) annotates edges with the producer attribute", () => {
    const ir = applyDetail(base, DETAIL.ATTRIBUTES);
    expect(ir.edges).toContainEqual({ from: "subnet", to: "vpc", kind: "ref", viaAttr: "network", toAttr: "id" });
    expect(ir.edges).toContainEqual({
      from: "dbDeployment",
      to: "subnet",
      kind: "ref",
      viaAttr: "subnet",
      toAttr: "selfLink",
    });
  });
});
