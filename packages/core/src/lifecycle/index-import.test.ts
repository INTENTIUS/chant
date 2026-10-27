/**
 * #4524: the pure part of `chant import --index` over a hand-made index,
 * with a fake lexicon seam, so every rule is checked without a generated
 * lexicon: selection, references from derived edges, secrets as parameters,
 * declared nodes left out, unsupported nodes named, groups and determinism.
 * The aws seam and its round trip through the generator and a build are in
 * lexicons/aws/src/index-import.test.ts.
 */
import { describe, expect, test } from "vitest";
import { MASKED } from "../deep-observation";
import type { IREdge, IRNode } from "../graph-ir";
import type { IndexIdentity } from "./identity-match";
import { indexDocumentDigest, indexScopeKey, type CloudIndexScope, type IndexDocument } from "./index-document";
import {
  declaredNodes,
  edgeRulePath,
  indexImportHeader,
  nodeSelected,
  planIndexImport,
  selectionIsEmpty,
  type IndexImportCodegen,
  type IndexImportLexicon,
} from "./index-import";

const SCOPE: CloudIndexScope = { kind: "cloud", substrate: "aws", scopeId: "111", locations: ["r1", "r2"], types: "*" };

function node(kind: string, location: string, nativeId: string, attrs: Record<string, unknown>, extra: Partial<IRNode> = {}): IRNode {
  return {
    id: `aws/111/${location}/${kind}/${nativeId}`,
    kind,
    lexicon: "fake",
    attrs,
    listedType: kind,
    location,
    nativeId,
    physicalId: nativeId,
    tags: {},
    facts: { cloudIds: [{ kind: "arn", value: `arn:${kind}:${nativeId}` }], observedAt: "2026-10-26T00:00:00.000Z" },
    ...extra,
  };
}

function edge(from: IRNode, to: IRNode, path: string, extra: Partial<IREdge> = {}): IREdge {
  return { from: from.id, to: to.id, kind: "ref", origin: "derived", grain: "property", rule: `fake:${from.kind}:${path}`, viaAttr: path, ...extra };
}

function docOf(nodes: IRNode[], edges: IREdge[]): IndexDocument {
  const graph = { version: 1 as const, nodes, edges, groups: {} };
  return {
    index: "v1",
    stamp: {
      source: { kind: "cloud", name: "behold-lister" },
      scope: SCOPE,
      scopeKey: indexScopeKey(SCOPE),
      observedAt: "2026-10-26T00:00:00.000Z",
      digest: indexDocumentDigest({ graph, coverage: [] }),
    },
    coverage: [{ listedType: "*", location: "*", verdict: "listed" }],
    graph,
  };
}

const fake: IndexImportCodegen = {
  resource: (n) => (n.kind === "Fake::Refused" ? { unsupported: "refused by the fake lexicon" } : { type: n.kind, properties: n.attrs }),
  reference: (value, target) =>
    value === target.node.nativeId ? { ref: target.logicalId } : value === `arn:${target.node.kind}:${target.node.nativeId}` ? { arn: target.logicalId } : undefined,
  secretParameter: (name, ctx) => ({ name, type: "String", description: `${ctx.path} of ${ctx.node.id}` }),
  parameterReference: (name) => ({ param: name }),
};
const LEX: IndexImportLexicon[] = [{ name: "fake", indexImport: fake }];

const net = node("Fake::Net", "r1", "net-1", { Cidr: "10.0.0.0/16" });
const sub = node("Fake::Sub", "r1", "sub-1", { NetId: "net-1", Cidr: "10.0.1.0/24" }, { tags: { team: "a" } });
const vm = node("Fake::Vm", "r1", "vm-1", {
  SubIds: ["sub-1", "sub-elsewhere"],
  Role: "arn:Fake::Role:role-1",
  Password: MASKED,
  Disks: [{ Key: MASKED }],
}, { tags: { team: "a" } });
const role = node("Fake::Role", "global", "role-1", { Name: "role-1" });
const far = node("Fake::Net", "r2", "net-2", { Cidr: "10.1.0.0/16" });
const odd = node("Unmapped::Thing", "r1", "t-1", {}, { unmappedKind: true, lexicon: "aws" });
const refused = node("Fake::Refused", "r1", "x-1", {});
const other = { ...node("Other::Kind", "r1", "o-1", {}), lexicon: "other" };

const EDGES = [
  edge(sub, net, "NetId", { relation: "containment" }),
  edge(vm, sub, "SubIds[]"),
  { ...edge(vm, role, "Role"), rule: "identity-match:fake:Fake::Vm:arn" },
  edge(far, net, "Peer"),
];
const DOC = docOf([net, sub, vm, role, far, odd, refused, other], EDGES);

describe("selection", () => {
  test("an empty selection selects nothing", () => {
    expect(selectionIsEmpty({})).toBe(true);
    expect(nodeSelected(net, {})).toBe(false);
    expect(planIndexImport([DOC], {}, LEX).report.resources).toEqual([]);
  });

  test("types, names, nodes and tags narrow; within one field any value matches", () => {
    expect(nodeSelected(net, { types: ["Fake::Net", "Fake::Sub"] })).toBe(true);
    expect(nodeSelected(vm, { types: ["Fake::Net"] })).toBe(false);
    expect(nodeSelected(sub, { names: ["sub-1"] })).toBe(true);
    expect(nodeSelected(sub, { nodes: [sub.id] })).toBe(true);
    expect(nodeSelected(sub, { tags: { team: "a" } })).toBe(true);
    expect(nodeSelected(net, { tags: { team: "a" } })).toBe(false);
    expect(nodeSelected(vm, { types: ["Fake::Vm"], tags: { team: "b" } })).toBe(false);
  });
});

describe("planIndexImport", () => {
  const plan = planIndexImport([DOC], { all: true }, LEX);
  const report = (n: IRNode) => plan.report.resources.find((r) => r.node === n.id)!;

  test("a derived edge to an imported node in the same group becomes a reference", () => {
    const g = plan.groups.find((x) => x.location === "r1")!;
    const subIr = g.ir.resources.find((r) => r.type === "Fake::Sub")!;
    expect(subIr.properties.NetId).toEqual({ ref: report(net).logicalId });
    expect(report(sub).references).toEqual([{ path: "NetId", target: net.id, rule: "fake:Fake::Sub:NetId", written: "reference" }]);
  });

  test("an array path rewrites only the values that name the target", () => {
    const g = plan.groups.find((x) => x.location === "r1")!;
    const vmIr = g.ir.resources.find((r) => r.type === "Fake::Vm")!;
    expect(vmIr.properties.SubIds).toEqual([{ ref: report(sub).logicalId }, "sub-elsewhere"]);
  });

  test("an identity-match edge, which names no path, is found by value", () => {
    const one = planIndexImport([DOC], { types: ["Fake::Vm", "Fake::Role", "Fake::Sub"] }, LEX);
    const vmIr = one.groups[0].ir.resources.find((r) => r.type === "Fake::Vm")!;
    expect(vmIr.properties.Role).toEqual({ arn: one.report.resources.find((r) => r.node === role.id)!.logicalId });
    expect(one.report.resources.find((r) => r.node === vm.id)!.references).toContainEqual({
      path: "Role",
      target: role.id,
      rule: "identity-match:fake:Fake::Vm:arn",
      written: "reference",
    });
  });

  test("a masked value becomes a parameter and is never written", () => {
    const vmIr = plan.groups.flatMap((g) => g.ir.resources).find((r) => r.type === "Fake::Vm")!;
    expect(JSON.stringify(plan.groups.map((g) => g.ir))).not.toContain(MASKED);
    const lid = report(vm).logicalId!;
    expect(vmIr.properties.Password).toEqual({ param: `${lid}Password` });
    expect((vmIr.properties.Disks as Array<Record<string, unknown>>)[0].Key).toEqual({ param: `${lid}Disks0Key` });
    expect(plan.report.parameters.map((p) => p.path)).toEqual(["Disks[0].Key", "Password"]);
    const params = plan.groups.flatMap((g) => g.ir.parameters).map((p) => p.name);
    expect(params).toEqual([`${lid}Disks0Key`, `${lid}Password`]);
    const g = plan.groups.find((x) => x.ir.resources.some((r) => r.type === "Fake::Vm"))!;
    expect(indexImportHeader(plan, g)).toContain(`fill in the parameter ${lid}Password`);
  });

  test("a masked value under a key that holds a dot is replaced at that key (#4538)", () => {
    const cm = node("Fake::Map", "r1", "map-1", { Data: { "db.host": "h", "db.password": MASKED } });
    const one = planIndexImport([docOf([cm], [])], { all: true }, LEX);
    const lid = one.report.resources[0].logicalId!;
    expect(one.groups[0].ir.resources[0].properties).toEqual({ Data: { "db.host": "h", "db.password": { param: `${lid}DataDbPassword` } } });
    expect(one.report.parameters.map((p) => p.path)).toEqual(["Data.db.password"]);
  });

  test("a codegen's notes go into the header after the logical id (#4538)", () => {
    const noting: IndexImportCodegen = { ...fake, resource: (n) => ({ type: n.kind, properties: n.attrs, notes: ["supplied out of band"] }) };
    const one = planIndexImport([docOf([net], [])], { all: true }, [{ name: "fake", indexImport: noting }]);
    expect(one.groups[0].header).toEqual([`${one.report.resources[0].logicalId}: supplied out of band`]);
  });

  test("an edge into another group stays a literal, and the header names the edge", () => {
    const g2 = plan.groups.find((x) => x.location === "r2")!;
    const farIr = g2.ir.resources[0];
    expect(farIr.properties).toEqual({ Cidr: "10.1.0.0/16" });
    expect(report(far).references?.[0]).toMatchObject({ path: "Peer", written: "literal" });
    expect(report(far).references?.[0].reason).toMatch(/another group/);
    expect(g2.header.join("\n")).toContain(`derived edge fake:Fake::Net:Peer to ${net.id}`);
  });

  test("two regions give two groups, and a global node with two regions to pick from gets its own", () => {
    expect(plan.groups.map((g) => g.dir)).toEqual(["fake/global", "fake/r1", "fake/r2"]);
  });

  test("a global node joins the only region", () => {
    const one = planIndexImport([DOC], { types: ["Fake::Vm", "Fake::Role"] }, LEX);
    expect(one.groups.map((g) => g.dir)).toEqual([""]);
    const vmIr = one.groups[0].ir.resources.find((r) => r.type === "Fake::Vm")!;
    expect(vmIr.properties.Role).toEqual({ arn: one.report.resources.find((r) => r.node === role.id)!.logicalId });
  });

  test("unmapped kinds, a lexicon with no seam and a refused node are named as unsupported", () => {
    expect(report(odd)).toMatchObject({ status: "unsupported" });
    expect(report(odd).reason).toMatch(/no lexicon kind maps/);
    expect(report(other).reason).toBe("the other lexicon is not loaded");
    const withOther = planIndexImport([DOC], { all: true }, [...LEX, { name: "other" }]);
    expect(withOther.report.resources.find((r) => r.node === other.id)!.reason).toMatch(/no index import codegen/);
    expect(report(refused).reason).toBe("refused by the fake lexicon");
  });

  test("the report names each resource's identity and cloud ids", () => {
    expect(report(vm).identity).toEqual({ substrate: "aws", scopeId: "111", listedType: "Fake::Vm", location: "r1", nativeId: "vm-1" });
    expect(report(vm).cloudIds).toEqual([{ kind: "arn", value: "arn:Fake::Vm:vm-1" }]);
    expect(plan.report.index).toEqual([{ scopeKey: DOC.stamp.scopeKey, observedAt: DOC.stamp.observedAt, digest: DOC.stamp.digest, source: "behold-lister" }]);
  });

  test("a declared node is reported with its entity and not imported; an edge to it stays a literal", () => {
    const declared = new Map([[net.id, "network"]]);
    const p = planIndexImport([DOC], { types: ["Fake::Net", "Fake::Sub"] }, LEX, { declared });
    const r = p.report.resources.find((x) => x.node === net.id)!;
    expect(r).toMatchObject({ status: "declared", entity: "network" });
    // The other Fake::Net (net-2, in r2) is selected by type and not declared, so it is imported.
    const imported = p.report.resources.filter((x) => x.status === "imported").map((x) => x.node);
    expect(imported).not.toContain(net.id);
    expect(imported).toEqual([far.id, sub.id].sort());
    expect(p.groups.flatMap((g) => g.ir.resources).filter((x) => x.type === "Fake::Net")).toHaveLength(1);
    const s = p.report.resources.find((x) => x.node === sub.id)!;
    expect(s.references?.[0]).toMatchObject({ written: "literal", reason: "the target is already declared as network" });
  });

  test("the same index and selection give the same plan, whatever the node and edge order", () => {
    // The same index version: same stamp, its nodes and edges listed in another order.
    const shuffled = { ...docOf([other, refused, far, role, odd, vm, net, sub], [...EDGES].reverse()), stamp: DOC.stamp };
    expect(JSON.stringify(planIndexImport([shuffled], { all: true }, LEX))).toBe(JSON.stringify(plan));
    expect(JSON.stringify(planIndexImport([DOC], { all: true }, LEX))).toBe(JSON.stringify(plan));
  });

  test("two reads are refused", () => {
    const later = { ...DOC, stamp: { ...DOC.stamp, observedAt: "2026-10-27T00:00:00.000Z" } };
    expect(() => planIndexImport([DOC, later], { all: true }, LEX)).toThrow(/one read of one account/);
  });

  test("logical ids are letters and digits, stable, and drop a repeated type word", () => {
    const ids = plan.report.resources.filter((r) => r.logicalId).map((r) => r.logicalId!);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(report(net).logicalId).toBe("Net1");
    expect(report(sub).logicalId).toBe("Sub1");
  });
});

describe("edgeRulePath", () => {
  test("a catalog rule names its path; tag and identity-match rules name none", () => {
    expect(edgeRulePath(EDGES[0], sub)).toBe("NetId");
    expect(edgeRulePath({ ...EDGES[0], rule: "fake:Fake::Sub:tag:owner" }, sub)).toBeUndefined();
    expect(edgeRulePath(EDGES[2], vm)).toBeUndefined();
  });
});

describe("declaredNodes", () => {
  const identity: IndexIdentity = {
    substrate: "aws",
    declaredIdentity: (type, props) =>
      typeof props.Name === "string"
        ? { kind: "identifier", listedType: type, identifier: props.Name, global: type === "Fake::Role" }
        : { kind: "unmatchable", reason: "no-binding", detail: "no name" },
  };

  test("an entity the matcher binds marks its node as declared", () => {
    const entities = new Map([["fake", [
      { name: "network", entityType: "Fake::Net", props: { Name: "net-1" } },
      { name: "role", entityType: "Fake::Role", props: { Name: "role-1" } },
      { name: "nameless", entityType: "Fake::Sub", props: {} },
    ]]]);
    const declared = declaredNodes([DOC], entities, [{ name: "fake", indexIdentity: identity }]);
    expect([...declared.entries()].sort()).toEqual([[net.id, "network"], [role.id, "role"]].sort());
  });

  test("a lexicon with no identity rule declares nothing", () => {
    const entities = new Map([["fake", [{ name: "network", entityType: "Fake::Net", props: { Name: "net-1" } }]]]);
    expect(declaredNodes([DOC], entities, [{ name: "fake" }]).size).toBe(0);
  });
});
