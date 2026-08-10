import { describe, test, expect } from "vitest";
import { applyDetail, DETAIL, detailInertNotice } from "./graph-detail";
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
  test("T2 (declarables) keeps every node and its scalar/reference attrs", () => {
    const ir = applyDetail(base, DETAIL.DECLARABLES);
    expect(ir.nodes.map((n) => n.id)).toEqual(base.nodes.map((n) => n.id));
    expect(ir.edges).toEqual(base.edges);
    // Top-level reference envelopes are part of the resource view.
    expect(ir.nodes.find((n) => n.id === "subnet")!.attrs).toEqual({ network: { $ref: "vpc.id" } });
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
    // Topology view: a surviving plain node sheds its properties.
    expect(ir.nodes.find((n) => n.id === "subnet")!.attrs).toEqual({});
  });

  test("T1 keeps overlay paint on surviving plain nodes", () => {
    const painted: GraphIR = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "subnet" ? { ...n, attrs: { ...n.attrs, _status: "warn" } } : n,
      ),
    };
    const ir = applyDetail(painted, DETAIL.COMPOSITES);
    expect(ir.nodes.find((n) => n.id === "subnet")!.attrs).toEqual({ _status: "warn" });
  });

  test("T1 (composites) carries the cross-stack imports forward (survive the collapse as plain nodes)", () => {
    const withImports: GraphIR = {
      ...base,
      nodes: [...base.nodes, { id: "pClusterArn", kind: "AWS::CloudFormation::Parameter", lexicon: "aws", attrs: {} }],
      imports: [{ name: "pClusterArn", node: "pClusterArn" }],
    };
    const ir = applyDetail(withImports, DETAIL.COMPOSITES);
    // The import node isn't a composite, so it survives — and `imports` rides
    // along so a viewer can hide/match it at this tier too (not just base + T3).
    expect(ir.nodes.some((n) => n.id === "pClusterArn")).toBe(true);
    expect(ir.imports).toEqual([{ name: "pClusterArn", node: "pClusterArn" }]);
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

// #1489 — the k8s collapse: a convention-linked graph whose nodes carry nested
// property trees (every real k8s resource) must still differentiate across the
// dial. Modelled on the fountain-ops estate the issue measured: no composites,
// no `$ref` edges, full `metadata`/`spec` trees on every node.
describe("detail monotonicity (#1489)", () => {
  const k8sish: GraphIR = {
    nodes: [
      {
        id: "web",
        kind: "K8s::Apps::Deployment",
        lexicon: "k8s",
        attrs: {
          name: "web",
          namespace: "prod",
          uid: "u-1",
          metadata: { labels: { app: "web" } },
          spec: {
            replicas: 3,
            selector: { matchLabels: { app: "web" } },
            template: { spec: { containers: [{ name: "web", image: "nginx:1.27" }] } },
          },
        },
      },
      {
        id: "webSvc",
        kind: "K8s::Core::Service",
        lexicon: "k8s",
        attrs: {
          name: "web",
          namespace: "prod",
          metadata: {},
          spec: { selector: { app: "web" }, ports: [{ port: 80 }] },
        },
      },
      { id: "prodNs", kind: "K8s::Core::Namespace", lexicon: "k8s", attrs: { name: "prod", metadata: {} } },
    ],
    // Label-convention edges — no producer attribute anywhere.
    edges: [{ from: "webSvc", to: "web", kind: "ref", viaAttr: "spec.selector" }],
    groups: { byLexicon: { k8s: ["prodNs", "web", "webSvc"] } },
  };

  const attrKeys = (ir: GraphIR, id: string): string[] =>
    Object.keys(ir.nodes.find((n) => n.id === id)!.attrs).sort();

  test("attrs at level n are a subset of attrs at level n+1, strictly growing for a nested spec", () => {
    const t1 = applyDetail(k8sish, DETAIL.COMPOSITES);
    const t2 = applyDetail(k8sish, DETAIL.DECLARABLES);
    const t3 = applyDetail(k8sish, DETAIL.ATTRIBUTES);
    for (const id of ["web", "webSvc", "prodNs"]) {
      const k1 = attrKeys(t1, id);
      const k2 = attrKeys(t2, id);
      const k3 = attrKeys(t3, id);
      // subset at every step…
      expect(k2).toEqual(expect.arrayContaining(k1));
      expect(k3).toEqual(expect.arrayContaining(k2));
      // …and strictly growing: every node here has a nested tree beyond its scalars.
      expect(k1.length).toBeLessThan(k2.length);
      expect(k2.length).toBeLessThan(k3.length);
    }
    // The resource view is identity scalars; the attribute view adds the trees.
    expect(attrKeys(t2, "web")).toEqual(["name", "namespace", "uid"]);
    expect(attrKeys(t3, "web")).toEqual(["metadata", "name", "namespace", "spec", "uid"]);
    expect(t3.nodes.find((n) => n.id === "web")!.attrs.spec).toEqual(
      k8sish.nodes.find((n) => n.id === "web")!.attrs.spec,
    );
  });

  test("regression: levels 2 and 3 are not byte-identical for a convention-linked k8s graph", () => {
    const t2 = JSON.stringify(applyDetail(k8sish, DETAIL.DECLARABLES));
    const t3 = JSON.stringify(applyDetail(k8sish, DETAIL.ATTRIBUTES));
    expect(t3).not.toEqual(t2);
    expect(t3.length).toBeGreaterThan(t2.length);
    // …and 1 vs 2 differ too: three genuinely distinct zoom stops.
    const t1 = JSON.stringify(applyDetail(k8sish, DETAIL.COMPOSITES));
    expect(t2).not.toEqual(t1);
    expect(t2.length).toBeGreaterThan(t1.length);
  });
});

// #1489 — an inert --detail 3 names itself instead of silently emitting the
// same bytes as --detail 2. Since the attrs projection landed, T3 adds the
// property tree as well as edge annotations, so the notice only fires for a
// graph that has neither: flat attrs AND convention-linked edges.
describe("detailInertNotice (#1489)", () => {
  test("detail 3 that added toAttr annotations: no notice", () => {
    const detailed = applyDetail(base, DETAIL.ATTRIBUTES);
    expect(detailInertNotice(base, detailed)).toBeUndefined();
  });

  test("nested property trees make detail 3 real even without producer attrs: no notice", () => {
    const labelLinked: GraphIR = {
      nodes: [
        { id: "svc", kind: "Service", lexicon: "k8s", attrs: { spec: { selector: { app: "web" } } } },
        { id: "web", kind: "Deployment", lexicon: "k8s", attrs: { metadata: { labels: { app: "web" } } } },
      ],
      edges: [{ from: "svc", to: "web", kind: "ref", viaAttr: "spec.selector" }],
      groups: {},
    };
    const detailed = applyDetail(labelLinked, DETAIL.ATTRIBUTES);
    expect(detailInertNotice(labelLinked, detailed)).toBeUndefined();
  });

  test("flat attrs + convention-linked edges: notice names both causes", () => {
    const flat: GraphIR = {
      nodes: [
        { id: "svc", kind: "Service", lexicon: "k8s", attrs: { name: "svc" } },
        { id: "web", kind: "Deployment", lexicon: "k8s", attrs: { name: "web" } },
      ],
      edges: [{ from: "svc", to: "web", kind: "ref", viaAttr: "spec.selector" }],
      groups: {},
    };
    const detailed = applyDetail(flat, DETAIL.ATTRIBUTES);
    const notice = detailInertNotice(flat, detailed);
    expect(notice).toContain("--detail 3");
    expect(notice).toContain("1 edge(s)");
    expect(notice).toContain("resource view");
    expect(notice).toContain("identical to --detail 2");
  });

  test("no edges at all: notice says so", () => {
    const edgeless: GraphIR = {
      nodes: [{ id: "ns", kind: "Namespace", lexicon: "k8s", attrs: {} }],
      edges: [],
      groups: {},
    };
    const detailed = applyDetail(edgeless, DETAIL.ATTRIBUTES);
    expect(detailInertNotice(edgeless, detailed)).toContain("no edges at all");
  });
});
