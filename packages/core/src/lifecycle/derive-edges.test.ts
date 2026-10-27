import { describe, expect, test } from "vitest";
import type { ReferenceCatalog } from "../graph-refs";
import type { IndexDocument } from "./index-document";
import { validateIndexDocument } from "./index-document";
import { deriveEdges, deriveEdgesAcross, type EdgeLexicon } from "./derive-edges";
import { typeListing, type ListedResource, type ListingLexicon, type ListingResult } from "./type-listing";

// #4522, to the rules ruled on INTENTIUS/behold#1023 (2026-10-26).
const catalog: ReferenceCatalog = {
  identities: [
    { kind: "Db::SubnetGroup", ids: ["Name"] },
    { kind: "Iam::Role", ids: ["RoleName"] },
    { kind: "Logs::Group", ids: ["GroupName"] },
    { kind: "Svc::Cluster", ids: ["ClusterName"] },
    { kind: "Eks::Cluster", ids: ["Name"] },
  ],
  refs: [
    { from: "Db::Instance", path: "SubnetGroupName", targetKind: "Db::SubnetGroup", relation: "reference", label: "subnets" },
    { from: "Task::Definition", path: "TaskRoleArn", targetKind: "Iam::Role", relation: "reference", label: "role" },
    // Untargeted, the shape #1023 found false joins in: a name could be anything's.
    { from: "Svc::Service", path: "Cluster", relation: "reference", label: "in cluster" },
    { from: "Net::Subnet", path: "VpcId", targetKind: "Net::Vpc", relation: "containment", label: "in VPC" },
  ],
  tagRefs: [{ key: "kubernetes.io/cluster/", read: "key-suffix", targetKind: "Eks::Cluster" }],
};

const KINDS = ["Db::Instance", "Db::SubnetGroup", "Iam::Role", "Logs::Group", "Svc::Cluster", "Svc::Service", "Task::Definition", "Net::Subnet", "Net::Vpc", "Eks::Cluster"];
const typing: ListingLexicon[] = [{ name: "fake", listedTypes: { substrate: "aws", kindFor: (t) => (KINDS.includes(t) ? t : undefined) } }];
const lexicons: EdgeLexicon[] = [{ name: "fake", referenceCatalog: catalog }];

const r = (listedType: string, location: string, nativeId: string, properties: Record<string, unknown>, extra: Partial<ListedResource> = {}): ListedResource => ({
  listedType,
  location,
  nativeId,
  cloudIds: [{ kind: "import-id", value: nativeId }],
  tags: {},
  properties,
  observedAt: "2026-10-26T09:00:01.000Z",
  ...extra,
});

const RESOURCES: ListedResource[] = [
  r("Db::Instance", "us-east-1", "orders", { SubnetGroupName: "default" }),
  r("Db::SubnetGroup", "us-east-1", "default", { Name: "default" }),
  r("Db::SubnetGroup", "us-west-2", "default", { Name: "default" }),
  r("Iam::Role", "global", "app", { RoleName: "app" }, { cloudIds: [{ kind: "arn", value: "arn:aws:iam::000000000000:role/app" }, { kind: "import-id", value: "app" }] }),
  r("Task::Definition", "us-east-1", "arn:aws:ecs:us-east-1:000000000000:task-definition/web:1", { TaskRoleArn: "arn:aws:iam::000000000000:role/app" }),
  r("Svc::Cluster", "us-east-1", "default", { ClusterName: "default" }),
  r("Logs::Group", "us-east-1", "default", { GroupName: "default" }),
  r("Svc::Service", "us-east-1", "web", { Cluster: "default" }),
  r("Net::Vpc", "us-east-1", "vpc-1", {}),
  r("Net::Subnet", "us-east-1", "subnet-1", { VpcId: "vpc-1" }, { tags: { "kubernetes.io/cluster/prod": "shared", team: "prod" } }),
  r("Net::Subnet", "us-east-1", "subnet-2", { VpcId: "vpc-gone" }),
  r("Eks::Cluster", "us-east-1", "prod", { Name: "prod" }),
  // A node whose value equals the cluster's name, only by its tag value: tags never join by value.
  r("Logs::Group", "us-east-1", "team", { GroupName: "team" }),
];

function listing(resources: ListedResource[], extra: Partial<ListingResult> = {}): ListingResult {
  return {
    listing: "v1",
    source: { name: "behold-lister", version: "0.0.0-test" },
    scope: { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1", "us-west-2"], types: "*" },
    startedAt: "2026-10-26T09:00:00.000Z",
    completedAt: "2026-10-26T09:00:04.000Z",
    resources,
    coverage: [{ listedType: "*", location: "*", verdict: "listed" }],
    notes: [],
    ...extra,
  };
}

const id = (location: string, type: string, nativeId: string) => `aws/000000000000/${location}/${type}/${nativeId}`;
const pairsOf = (doc: IndexDocument) => doc.graph.edges.map((e) => `${e.from} -> ${e.to} [${e.viaAttr}] ${e.relation} ${e.rule}`);

describe("deriveEdges", () => {
  const doc = deriveEdges(typeListing(listing(RESOURCES), typing), lexicons);

  test("every edge is derived, with its rule and property grain", () => {
    expect(doc.graph.edges.length).toBeGreaterThan(0);
    for (const e of doc.graph.edges) {
      expect(e).toMatchObject({ kind: "ref", origin: "derived", grain: "property" });
      expect(e.rule).toMatch(/^fake:/);
    }
    expect(() => validateIndexDocument(doc)).not.toThrow();
  });

  test("the join key is scoped: a name joins in its own region, and a global type by account", () => {
    expect(pairsOf(doc)).toEqual(
      expect.arrayContaining([
        `${id("us-east-1", "Db::Instance", "orders")} -> ${id("us-east-1", "Db::SubnetGroup", "default")} [SubnetGroupName] reference fake:Db::Instance:SubnetGroupName`,
        `${id("us-east-1", "Task::Definition", "arn:aws:ecs:us-east-1:000000000000:task-definition/web:1")} -> ${id("global", "Iam::Role", "app")} [TaskRoleArn] reference fake:Task::Definition:TaskRoleArn`,
      ]),
    );
    expect(pairsOf(doc).some((p) => p.includes(id("us-west-2", "Db::SubnetGroup", "default")))).toBe(false);
  });

  test("a value matching several nodes draws no edge and is noted with every candidate", () => {
    const service = id("us-east-1", "Svc::Service", "web");
    expect(doc.graph.edges.some((e) => e.from === service)).toBe(false);
    const note = doc.notes?.find((n) => n.kind === "ambiguous-reference");
    expect(note?.message).toContain(service);
    expect(note?.message).toContain(id("us-east-1", "Svc::Cluster", "default"));
    expect(note?.message).toContain(id("us-east-1", "Logs::Group", "default"));
    expect(note?.message).toContain("fake:Svc::Service:Cluster");
  });

  test("containment is an edge with its relation, and a box in groups.byContainer", () => {
    const subnet = id("us-east-1", "Net::Subnet", "subnet-1");
    const vpc = id("us-east-1", "Net::Vpc", "vpc-1");
    expect(doc.graph.edges).toContainEqual(expect.objectContaining({ from: subnet, to: vpc, viaAttr: "VpcId", relation: "containment" }));
    expect(doc.graph.groups.byContainer?.[vpc]).toEqual([subnet]);
  });

  test("a reference to nothing in the index is dangling, never an edge", () => {
    expect(doc.graph.dangling).toContainEqual({ from: id("us-east-1", "Net::Subnet", "subnet-2"), kind: "ref", path: "VpcId", value: "vpc-gone" });
  });

  test("tags join only through a typed rule for a key that names a cloud id", () => {
    const subnet = id("us-east-1", "Net::Subnet", "subnet-1");
    expect(doc.graph.edges).toContainEqual(
      expect.objectContaining({ from: subnet, to: id("us-east-1", "Eks::Cluster", "prod"), viaAttr: "Tags", rule: "fake:Net::Subnet:tag:kubernetes.io/cluster/" }),
    );
    // `team: prod` equals a cluster's name and a log group's name: no edge from a tag value.
    expect(doc.graph.edges.some((e) => e.from === subnet && e.to === id("us-east-1", "Logs::Group", "team"))).toBe(false);
  });

  test("a lexicon with no catalog is named in the notes, and its nodes get no edges", () => {
    const withAzure = typeListing(
      listing([r("microsoft.storage/storageaccounts", "eastus", "/subscriptions/s/x", {})], {
        scope: { substrate: "azure", scopeId: "s", locations: "*", types: "*" },
      }),
      [{ name: "azure", listedTypes: { substrate: "azure", kindFor: () => "Microsoft.Storage/storageAccounts" } }],
    );
    const out = deriveEdges(withAzure, [...lexicons, { name: "azure" }]);
    expect(out.graph.edges).toEqual([]);
    expect(out.notes?.find((n) => n.kind === "no-catalog")?.message).toContain("azure");
  });

  test("derivation is idempotent", () => {
    expect(deriveEdges(doc, lexicons)).toEqual(doc);
  });
});

describe("node order", () => {
  // A small seeded shuffle, so a failure reproduces.
  function shuffled<T>(xs: readonly T[], seed: number): T[] {
    const out = [...xs];
    let s = seed;
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  test("the edge set, dangling set and notes do not depend on the order nodes were listed in", () => {
    const base = deriveEdges(typeListing(listing(RESOURCES), typing), lexicons);
    for (const seed of [1, 2, 3, 7, 42, 1009]) {
      const doc = typeListing(listing(RESOURCES), typing);
      // Shuffle the typed nodes themselves, past typeListing's own sort.
      const scrambled: IndexDocument = { ...doc, graph: { ...doc.graph, nodes: shuffled(doc.graph.nodes, seed) } };
      const out = deriveEdges(scrambled, [...lexicons].reverse());
      expect(out.graph.edges).toEqual(base.graph.edges);
      expect(out.graph.dangling).toEqual(base.graph.dangling);
      expect(out.graph.groups.byContainer).toEqual(base.graph.groups.byContainer);
      expect(out.notes).toEqual(base.notes);
    }
  });
});

describe("deriveEdgesAcross", () => {
  const regional = typeListing(listing(RESOURCES.filter((x) => x.location !== "global")), typing);
  const accountLevel = typeListing(
    listing(RESOURCES.filter((x) => x.location === "global"), { scope: { substrate: "aws", scopeId: "000000000000", locations: ["global"], types: "*" } }),
    typing,
  );

  test("joins every document of one account from one read, and stores each edge with its holder", () => {
    const [r1, g1] = deriveEdgesAcross([regional, accountLevel], lexicons);
    const task = id("us-east-1", "Task::Definition", "arn:aws:ecs:us-east-1:000000000000:task-definition/web:1");
    expect(r1.graph.edges).toContainEqual(expect.objectContaining({ from: task, to: id("global", "Iam::Role", "app"), rule: "fake:Task::Definition:TaskRoleArn" }));
    expect(g1.graph.edges).toEqual([]);
  });

  test("refuses two accounts, or two reads", () => {
    const other = typeListing(listing(RESOURCES, { scope: { substrate: "aws", scopeId: "111111111111", locations: ["us-east-1"], types: "*" } }), typing);
    expect(() => deriveEdgesAcross([regional, other], lexicons)).toThrow(/one account/);
    const later = typeListing(listing(RESOURCES, { startedAt: "2026-10-27T09:00:00.000Z" }), typing);
    expect(() => deriveEdgesAcross([regional, later], lexicons)).toThrow(/one read/);
  });
});
