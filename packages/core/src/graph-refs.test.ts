import { describe, it, expect } from "vitest";
import { reconstructEdges, readPath, mergeCatalogs, containmentGroups, type ReferenceCatalog } from "./graph-refs";
import type { IRNode } from "./graph-ir";

const node = (id: string, kind: string, attrs: Record<string, unknown>, physicalId?: string): IRNode => ({
  id,
  kind,
  lexicon: "test",
  attrs,
  ...(physicalId ? { physicalId } : {}),
});

describe("readPath", () => {
  it("reads nested keys", () => {
    expect(readPath({ a: { b: "x" } }, "a.b")).toEqual(["x"]);
  });
  it("fans out over arrays", () => {
    expect(readPath({ sgs: [{ id: "sg-1" }, { id: "sg-2" }] }, "sgs[].id")).toEqual(["sg-1", "sg-2"]);
  });
  it("reads an array of scalars", () => {
    expect(readPath({ subnets: ["s-1", "s-2"] }, "subnets[]")).toEqual(["s-1", "s-2"]);
  });
  it("returns nothing for a missing path", () => {
    expect(readPath({ a: 1 }, "b.c")).toEqual([]);
  });
});

describe("reconstructEdges", () => {
  // A tiny synthetic model: a "box" contains "things"; things reference a "peer".
  const catalog: ReferenceCatalog = {
    identities: [
      { kind: "Box", ids: ["BoxId"] },
      { kind: "Thing", ids: ["ThingId"] },
      { kind: "Peer", ids: ["PeerId"] },
    ],
    refs: [
      { from: "Thing", path: "boxId", targetKind: "Box", relation: "containment", label: "in box" },
      { from: "Thing", path: "peerIds[]", targetKind: "Peer", relation: "reference", label: "uses" },
    ],
  };

  const nodes: IRNode[] = [
    node("box", "Box", { BoxId: "box-1" }),
    node("thing", "Thing", { ThingId: "thing-1", boxId: "box-1", peerIds: ["peer-1", "peer-2"] }),
    node("peerA", "Peer", { PeerId: "peer-1" }),
    node("peerB", "Peer", { PeerId: "peer-2" }),
  ];

  it("emits reference edges (holder → referenced)", () => {
    const { edges } = reconstructEdges(nodes, catalog);
    expect(edges).toEqual([
      { from: "thing", to: "peerA", kind: "ref", viaAttr: "uses" },
      { from: "thing", to: "peerB", kind: "ref", viaAttr: "uses" },
    ]);
  });

  it("emits containment separately, not as edges", () => {
    const { edges, containment } = reconstructEdges(nodes, catalog);
    expect(containment).toEqual([{ child: "thing", parent: "box", label: "in box" }]);
    // containment is NOT in edges
    expect(edges.some((e) => e.to === "box")).toBe(false);
  });

  it("surfaces references to absent targets as dangling, never a wrong edge", () => {
    const withDangling = [...nodes, node("orphan", "Thing", { ThingId: "t-2", boxId: "box-1", peerIds: ["peer-GONE"] })];
    const { edges, dangling } = reconstructEdges(withDangling, catalog);
    expect(dangling).toContainEqual({ from: "orphan", path: "peerIds[]", value: "peer-GONE", targetKind: "Peer" });
    expect(edges.some((e) => e.to === undefined)).toBe(false);
  });

  it("resolves against physicalId too", () => {
    const cat: ReferenceCatalog = { identities: [], refs: [{ from: "Thing", path: "peer", relation: "reference" }] };
    const ns = [node("t", "Thing", { peer: "phys-9" }), node("p", "Peer", {}, "phys-9")];
    expect(reconstructEdges(ns, cat).edges).toEqual([{ from: "t", to: "p", kind: "ref", viaAttr: "peer" }]);
  });

  it("disambiguates identifier collisions by targetKind", () => {
    const cat: ReferenceCatalog = {
      identities: [{ kind: "A", ids: ["id"] }, { kind: "B", ids: ["id"] }],
      refs: [{ from: "H", path: "ref", targetKind: "B", relation: "reference" }],
    };
    const ns = [node("a", "A", { id: "dup" }), node("b", "B", { id: "dup" }), node("h", "H", { ref: "dup" })];
    expect(reconstructEdges(ns, cat).edges).toEqual([{ from: "h", to: "b", kind: "ref", viaAttr: "ref" }]);
  });

  it("drops self-references", () => {
    const cat: ReferenceCatalog = { identities: [{ kind: "SG", ids: ["id"] }], refs: [{ from: "SG", path: "peers[]", relation: "reference" }] };
    const ns = [node("sg", "SG", { id: "sg-1", peers: ["sg-1"] })];
    expect(reconstructEdges(ns, cat).edges).toEqual([]);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(reconstructEdges(nodes, catalog))).toBe(JSON.stringify(reconstructEdges(nodes, catalog)));
  });
});

describe("containmentGroups", () => {
  it("inverts pairs into container → members, representing nesting flatly", () => {
    const groups = containmentGroups([
      { child: "subnetA", parent: "vpc" },
      { child: "subnetB", parent: "vpc" },
      { child: "instance1", parent: "subnetA" },
    ]);
    // vpc contains its subnets; subnetA is a key with its own members (nesting).
    expect(groups).toEqual({ vpc: ["subnetA", "subnetB"], subnetA: ["instance1"] });
  });

  it("dedupes members and sorts keys + members", () => {
    expect(
      containmentGroups([
        { child: "b", parent: "a" },
        { child: "b", parent: "a" },
        { child: "a", parent: "z" },
      ]),
    ).toEqual({ a: ["b"], z: ["a"] });
  });

  it("is empty for no containment", () => {
    expect(containmentGroups([])).toEqual({});
  });
});

describe("mergeCatalogs", () => {
  it("concatenates identities and refs", () => {
    const a: ReferenceCatalog = { identities: [{ kind: "A", ids: ["x"] }], refs: [{ from: "A", path: "p", relation: "reference" }] };
    const b: ReferenceCatalog = { identities: [{ kind: "B", ids: ["y"] }], refs: [] };
    const m = mergeCatalogs([a, b]);
    expect(m.identities).toHaveLength(2);
    expect(m.refs).toHaveLength(1);
  });
});

// #1275 — `viaAttr` defaulted to `label ?? path`, which serves a renderer and
// starves a traversal: the catalog's labels are human-facing ("sg", "via")
// while a fold matches provider attribute names ("SecurityGroupIds").
describe("traversal name vs rendering label (#1275)", () => {
  const nodes: IRNode[] = [
    { id: "web", kind: "AWS::EC2::Instance", lexicon: "aws", attrs: { SubnetId: "subnet-1", SecurityGroups: [{ GroupId: "sg-1" }] } },
    { id: "sub", kind: "AWS::EC2::Subnet", lexicon: "aws", attrs: { SubnetId: "subnet-1" } },
    { id: "sg", kind: "AWS::EC2::SecurityGroup", lexicon: "aws", attrs: { GroupId: "sg-1" } },
  ];
  const identities = [
    { kind: "AWS::EC2::Subnet", ids: ["SubnetId"] },
    { kind: "AWS::EC2::SecurityGroup", ids: ["GroupId"] },
  ];

  it("viaAttr wins over label, so the fold can match the attribute name", () => {
    const { edges } = reconstructEdges(nodes, {
      identities,
      refs: [
        { from: "AWS::EC2::Instance", path: "SecurityGroups[].GroupId", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg", viaAttr: "SecurityGroupIds" },
      ],
    });
    expect(edges).toEqual([{ from: "web", to: "sg", kind: "ref", viaAttr: "SecurityGroupIds" }]);
  });

  it("without viaAttr the label still wins, unchanged", () => {
    const { edges } = reconstructEdges(nodes, {
      identities,
      refs: [
        { from: "AWS::EC2::Instance", path: "SecurityGroups[].GroupId", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg" },
      ],
    });
    expect(edges[0].viaAttr).toBe("sg");
  });

  it("a containment rule with viaAttr yields both the boundary pair and a traversable edge", () => {
    // An instance is *in* a subnet — a boundary for the picture, and the first
    // hop of internetFacing. It has to be both without being drawn twice.
    const { edges, containment } = reconstructEdges(nodes, {
      identities,
      refs: [
        { from: "AWS::EC2::Instance", path: "SubnetId", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet", viaAttr: "SubnetId" },
      ],
    });
    expect(containment).toEqual([{ child: "web", parent: "sub", label: "in subnet" }]);
    expect(edges).toEqual([{ from: "web", to: "sub", kind: "ref", viaAttr: "SubnetId" }]);
  });

  it("a containment rule without viaAttr stays a boundary hint only", () => {
    const { edges, containment } = reconstructEdges(nodes, {
      identities,
      refs: [
        { from: "AWS::EC2::Instance", path: "SubnetId", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet" },
      ],
    });
    expect(containment).toHaveLength(1);
    expect(edges).toEqual([]);
  });
});
