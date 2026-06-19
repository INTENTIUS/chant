import { describe, test, expect } from "vitest";
import { buildGraphIr } from "./graph-ir";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import { AttrRef } from "./attrref";
import { resolveAttrRefs } from "./discovery/resolve";
import { setProvenance } from "./provenance";

function decl<T extends object>(base: T): Declarable & T {
  return { [DECLARABLE_MARKER]: true, ...base } as Declarable & T;
}

describe("buildGraphIr", () => {
  test("emits a node per resource with kind, lexicon, and scrubbed attrs", () => {
    const vpc = decl({ lexicon: "gcp", entityType: "Vpc", props: { autoCreateSubnetworks: false } });
    const entities = new Map<string, Declarable>([["vpc", vpc]]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.nodes).toHaveLength(1);
    expect(ir.nodes[0]).toMatchObject({ id: "vpc", kind: "Vpc", lexicon: "gcp" });
    // `props` is flattened into attrs (field reads as the property, not props.x).
    expect(ir.nodes[0].attrs).toEqual({ autoCreateSubnetworks: false });
    // Framework fields are scrubbed out of attrs.
    expect(ir.nodes[0].attrs).not.toHaveProperty("lexicon");
    expect(ir.nodes[0].attrs).not.toHaveProperty("entityType");
  });

  test("derives ref edges labelled with the consumer property", () => {
    const vpc = decl({ lexicon: "gcp", entityType: "Vpc" });
    const subnet = decl({ lexicon: "gcp", entityType: "Subnet", props: { network: new AttrRef(vpc, "id") } });
    const entities = new Map<string, Declarable>([
      ["vpc", vpc],
      ["subnet", subnet],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.edges).toEqual([{ from: "subnet", to: "vpc", kind: "ref", viaAttr: "network" }]);
    // The ref also appears in the consumer's attrs as an auditable envelope.
    expect(ir.nodes.find((n) => n.id === "subnet")!.attrs).toEqual({
      network: { $ref: "vpc.id" },
    });
  });

  test("excludes property-kind declarables and keeps resources", () => {
    const resource = decl({ lexicon: "k8s", entityType: "Deployment" });
    const prop = decl({ lexicon: "k8s", entityType: "Probe", kind: "property" as const });
    const entities = new Map<string, Declarable>([
      ["dep", resource],
      ["probe", prop],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.nodes.map((n) => n.id)).toEqual(["dep"]);
  });

  test("populates compositeParent and byComposite from provenance", () => {
    const sts = decl({ lexicon: "k8s", entityType: "StatefulSet" });
    const svc = decl({ lexicon: "k8s", entityType: "Service" });
    setProvenance(sts, { composite: "CockroachDbCluster", sourceFile: "/proj/src/db.ts" });
    setProvenance(svc, { composite: "CockroachDbCluster", sourceFile: "/proj/src/db.ts" });
    const entities = new Map<string, Declarable>([
      ["dbSts", sts],
      ["dbSvc", svc],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities, "/proj");
    expect(ir.nodes.every((n) => n.compositeParent === "CockroachDbCluster")).toBe(true);
    expect(ir.groups.byComposite).toEqual({ CockroachDbCluster: ["dbSts", "dbSvc"] });
    // Source file is relativized to the project root.
    expect(ir.nodes[0].sourceLoc).toEqual({ file: "src/db.ts" });
  });

  test("reads non-enumerable props like real lexicon entities", () => {
    // Real lexicon resources define lexicon/entityType/props as non-enumerable,
    // so Object.entries(entity) is empty — attrs and edges must come from props.
    const vpc = decl({ lexicon: "gcp", entityType: "Vpc" });
    const subnet = { [DECLARABLE_MARKER]: true } as Declarable & { props: unknown };
    Object.defineProperties(subnet, {
      lexicon: { value: "gcp", enumerable: false },
      entityType: { value: "Subnet", enumerable: false },
      props: { value: { cidr: "10.0.0.0/16", network: new AttrRef(vpc, "id") }, enumerable: false },
    });
    const entities = new Map<string, Declarable>([
      ["vpc", vpc],
      ["subnet", subnet],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    const subnetNode = ir.nodes.find((n) => n.id === "subnet")!;
    expect(subnetNode.attrs).toEqual({ cidr: "10.0.0.0/16", network: { $ref: "vpc.id" } });
    expect(ir.edges).toEqual([{ from: "subnet", to: "vpc", kind: "ref", viaAttr: "network" }]);
  });

  test("groups nodes by lexicon and is deterministic", () => {
    const a = decl({ lexicon: "gcp", entityType: "Vpc" });
    const b = decl({ lexicon: "k8s", entityType: "Namespace" });
    const c = decl({ lexicon: "gcp", entityType: "Subnet" });
    const entities = new Map<string, Declarable>([
      ["zeta", c],
      ["alpha", a],
      ["mid", b],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.nodes.map((n) => n.id)).toEqual(["alpha", "mid", "zeta"]); // sorted
    expect(ir.groups.byLexicon).toEqual({ gcp: ["alpha", "zeta"], k8s: ["mid"] });

    // Same input (different insertion order) yields identical IR.
    const reordered = new Map<string, Declarable>([
      ["alpha", a],
      ["mid", b],
      ["zeta", c],
    ]);
    resolveAttrRefs(reordered);
    expect(JSON.stringify(buildGraphIr(reordered))).toEqual(JSON.stringify(ir));
  });
});
