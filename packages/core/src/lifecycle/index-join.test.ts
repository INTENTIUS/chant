import { describe, expect, test } from "vitest";
import type { GraphIR, IRNode } from "../graph-ir";
import type { DeclaredIdentity, IndexIdentity } from "./identity-match";
import type { IndexDocument } from "./index-document";
import {
  countJoins,
  formatIndexRef,
  indexOnlyGraph,
  joinCell,
  joinDeclaredToIndex,
  parseIndexRef,
  readIndexRef,
  type JoinLexicon,
} from "./index-join";
import { fakeSnapshotStore } from "./snapshot-store-fake";
import { typeListing, type ListedResource, type ListingLexicon, type ListingResult } from "./type-listing";

// #4525: `chant search --index <ref>`, the ref and the join, over a fixture
// index typed the way behold#1026 writes one (#4521's typeListing).

const IDENTITY: Record<string, { parts?: string[]; serverAssigned?: boolean; global?: boolean }> = {
  "Store::Bucket": { parts: ["BucketName"] },
  "Iam::Role": { parts: ["RoleName"], global: true },
  "Queue::Queue": { parts: ["QueueUrl"], serverAssigned: true },
  "Kv::Table": { parts: ["TableName"] },
};

const identity: IndexIdentity = {
  substrate: "aws",
  declaredIdentity(entityType, props): DeclaredIdentity {
    const row = IDENTITY[entityType];
    if (!row?.parts) return { kind: "unmatchable", reason: "unsupported-kind", detail: `${entityType} has no primary identifier on record` };
    if (row.serverAssigned) return { kind: "unmatchable", reason: "no-binding", detail: `${entityType} is assigned by the service` };
    const values: string[] = [];
    for (const p of row.parts) {
      const v = props[p];
      if (typeof v !== "string" || v === "") return { kind: "unmatchable", reason: "no-binding", detail: "identity is not in the declaration" };
      values.push(v);
    }
    return { kind: "identifier", listedType: entityType, identifier: values.join("|"), global: row.global === true };
  },
};

const typing: ListingLexicon[] = [{ name: "fake", listedTypes: { substrate: "aws", kindFor: (t) => (t in IDENTITY ? t : undefined) } }];
const lexicons: JoinLexicon[] = [{ name: "fake", indexIdentity: identity }, { name: "other" }];

const r = (listedType: string, location: string, nativeId: string, properties: Record<string, unknown> = {}, tags: Record<string, string> = {}): ListedResource => ({
  listedType,
  location,
  nativeId,
  cloudIds: [{ kind: "import-id", value: nativeId }],
  tags,
  properties,
  observedAt: "2026-10-26T09:00:01.000Z",
});

function listing(resources: ListedResource[]): ListingResult {
  return {
    listing: "v1",
    source: { name: "behold-lister", version: "0.0.0-test" },
    scope: { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: ["Store::Bucket", "Iam::Role", "Queue::Queue"] },
    startedAt: "2026-10-26T09:00:00.000Z",
    completedAt: "2026-10-26T09:00:04.000Z",
    resources,
    coverage: [
      { listedType: "Store::Bucket", location: "us-east-1", verdict: "listed" },
      { listedType: "Iam::Role", location: "global", verdict: "listed" },
      { listedType: "Queue::Queue", location: "us-east-1", verdict: "listed" },
    ],
    notes: [],
  };
}

const doc = typeListing(
  listing([
    r("Store::Bucket", "us-east-1", "shop-assets", { BucketName: "shop-assets", Arn: "arn:aws:s3:::shop-assets" }, { team: "web" }),
    r("Store::Bucket", "us-east-1", "made-by-hand", { BucketName: "made-by-hand" }),
    r("Iam::Role", "global", "app-runner", { RoleName: "app-runner" }),
    r("Queue::Queue", "us-east-1", "https://sqs.us-east-1.amazonaws.com/000000000000/orders", { QueueName: "orders" }),
  ]),
  typing,
);
const nodeId = (location: string, type: string, nativeId: string) => `aws/000000000000/${location}/${type}/${nativeId}`;

const node = (id: string, kind: string, attrs: Record<string, unknown>, lexicon = "fake"): IRNode => ({ id, kind, lexicon, attrs });
function graph(nodes: IRNode[]): GraphIR {
  return { version: 1, nodes, edges: [], groups: { byLexicon: {} } };
}

describe("parseIndexRef", () => {
  const key = doc.stamp.scopeKey;

  test("a scope key alone is its latest version", () => {
    expect(parseIndexRef(key)).toEqual({ scopeKey: key, version: "latest" });
    expect(parseIndexRef(`${key}@latest`)).toEqual({ scopeKey: key, version: "latest" });
  });

  test("a version is taken with or without .json, after @ or as the last path segment", () => {
    expect(parseIndexRef(`${key}@20261026T090000Z-0123456789ab`)).toEqual({ scopeKey: key, version: "20261026T090000Z-0123456789ab.json" });
    expect(parseIndexRef(`${key}@20261026T090000Z-0123456789ab.json`)).toEqual({ scopeKey: key, version: "20261026T090000Z-0123456789ab.json" });
    expect(parseIndexRef(`${key}/20261026T090000Z-0123456789ab.json`)).toEqual({ scopeKey: key, version: "20261026T090000Z-0123456789ab.json" });
  });

  test("a ref that names no source, no version or a dotted path is refused with the shape", () => {
    for (const bad of ["", "aws/000000000000", `${key}@yesterday`, "cloud/aws/../x", "cloud//aws"]) {
      const parsed = parseIndexRef(bad);
      expect(parsed).toMatchObject({ error: expect.any(String), hint: expect.stringContaining("scope key") });
    }
  });

  test("formatIndexRef drops .json", () => {
    expect(formatIndexRef("cloud/aws/a/b", "20261026T090000Z-0123456789ab.json")).toBe("cloud/aws/a/b@20261026T090000Z-0123456789ab");
  });
});

describe("readIndexRef", () => {
  const key = doc.stamp.scopeKey;
  const store = fakeSnapshotStore({
    readIndexLatest: async (k) => (k === key ? doc : null),
    readIndexAt: async (k, v) => (k === key && v.startsWith("2026") ? doc : null),
  });

  test("latest reads the newest version and names it", async () => {
    const read = await readIndexRef(store, { scopeKey: key, version: "latest" });
    expect("doc" in read && read.version).toMatch(/^20261026T090000Z-[0-9a-f]{12}\.json$/);
  });

  test("a scope key with nothing under it is refused, naming the key and the store", async () => {
    const read = await readIndexRef(store, { scopeKey: "cloud/aws/111111111111/0123456789ab", version: "latest" });
    expect(read).toMatchObject({ error: expect.stringContaining("cloud/aws/111111111111/0123456789ab") });
    expect("error" in read && read.error).toContain("the test store");
  });

  test("a version stamped for another version, or a document of another scope, is refused", async () => {
    const wrongVersion = await readIndexRef(store, { scopeKey: key, version: "20261026T090000Z-ffffffffffff.json" });
    expect(wrongVersion).toMatchObject({ error: expect.stringContaining("not the version asked for") });
    const elsewhere = fakeSnapshotStore({ readIndexLatest: async () => doc });
    const other = await readIndexRef(elsewhere, { scopeKey: "cloud/aws/111111111111/0123456789ab", version: "latest" });
    expect(other).toMatchObject({ error: expect.stringContaining("not the scope asked for") });
  });

  test("a store that throws is a refusal, not a crash", async () => {
    const broken = fakeSnapshotStore({ readIndexLatest: async () => { throw new Error("boom"); } });
    expect(await readIndexRef(broken, { scopeKey: key, version: "latest" })).toMatchObject({ error: expect.stringContaining("boom") });
  });
});

describe("joinDeclaredToIndex", () => {
  const declared = graph([
    node("east::assets", "Store::Bucket", { BucketName: "shop-assets" }),
    node("east::runner", "Iam::Role", { RoleName: "app-runner" }),
    node("east::archive", "Store::Bucket", { BucketName: "never-made" }),
    node("east::orders", "Queue::Queue", { QueueName: "orders" }),
    node("east::carts", "Kv::Table", { TableName: "carts" }),
    node("east::byRef", "Store::Bucket", { BucketName: { $ref: "name" } }),
    node("east::web", "Other::Thing", { Name: "web" }, "other"),
    node("loose", "Store::Bucket", { BucketName: "never-made" }),
  ]);
  const regionOf = (id: string) => (id.startsWith("east::") ? "us-east-1" : undefined);
  const { ir, joins } = joinDeclaredToIndex(declared, doc, lexicons, { regionOf });
  const row = (id: string) => ir.nodes.find((n) => n.id === id)!;

  test("every declared row has a verdict, and only declared rows are in the graph", () => {
    expect(Object.keys(joins).sort()).toEqual(declared.nodes.map((n) => n.id).sort());
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(declared.nodes.map((n) => n.id).sort());
    // made-by-hand is indexed, and no declaration binds it.
    expect(ir.nodes.some((n) => n.id.includes("made-by-hand"))).toBe(false);
  });

  test("a bound row carries the indexed node's id, native id and observed attributes", () => {
    expect(joins["east::assets"]).toMatchObject({ verdict: "bound", node: nodeId("us-east-1", "Store::Bucket", "shop-assets"), nativeId: "shop-assets" });
    expect(row("east::assets").physicalId).toBe("shop-assets");
    expect(row("east::assets").attrs).toMatchObject({ Arn: "arn:aws:s3:::shop-assets", _status: "good" });
    expect(joins["east::runner"]).toMatchObject({ verdict: "bound", location: "global" });
  });

  test("absent only where the index listed the type and location", () => {
    expect(joins["east::archive"]).toMatchObject({ verdict: "absent", listedType: "Store::Bucket", identifier: "never-made", location: "us-east-1" });
    expect(row("east::archive").physicalId).toBeUndefined();
    expect(row("east::archive").attrs?._status).toBe("accent");
  });

  test("a type outside the index's scope is not observed, with the coverage's reason", () => {
    expect(joins["east::carts"]).toMatchObject({ verdict: "not-observed", reason: "filtered" });
    expect(row("east::carts").attrs).toMatchObject({ _status: "neutral", _unobserved: "filtered" });
  });

  test("an identity the declaration does not spell is no-binding, never absent", () => {
    expect(joins["east::orders"]).toMatchObject({ verdict: "no-binding", detail: expect.stringContaining("assigned by the service") });
    expect(joins["east::byRef"]).toMatchObject({ verdict: "no-binding", detail: "identity is not in the declaration" });
    expect(row("east::orders").attrs?._unobserved).toBe("no-binding");
  });

  test("an entity with no region that matches nothing is no-binding, not absent", () => {
    expect(joins.loose).toMatchObject({ verdict: "no-binding", detail: expect.stringContaining("names no region") });
  });

  test("a lexicon with no index match is not observed, unsupported-kind", () => {
    expect(joins["east::web"]).toMatchObject({ verdict: "not-observed", reason: "unsupported-kind", detail: expect.stringContaining("other lexicon has no index match") });
  });

  test("two indexed nodes with one identity are ambiguous, bind neither and are painted unknown", () => {
    const twice = typeListing(
      {
        ...listing([r("Store::Bucket", "us-east-1", "shop-assets", { BucketName: "shop-assets" }), r("Store::Bucket", "us-west-2", "shop-assets", { BucketName: "shop-assets" })]),
        scope: { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1", "us-west-2"], types: ["Store::Bucket"] },
      },
      typing,
    );
    const { ir: g, joins: j } = joinDeclaredToIndex(graph([node("assets", "Store::Bucket", { BucketName: "shop-assets" })]), twice, lexicons);
    expect(j.assets).toMatchObject({ verdict: "ambiguous", candidates: [nodeId("us-east-1", "Store::Bucket", "shop-assets"), nodeId("us-west-2", "Store::Bucket", "shop-assets")] });
    const n = g.nodes.find((x) => x.id === "assets")!;
    expect(n.physicalId).toBeUndefined();
    expect(n.attrs?._status).toBe("neutral");
    expect(n.attrs?._unobserved).toBeUndefined();
    expect(joinCell(j.assets)).toBe("(ambiguous: 2 candidates)");
  });

  test("an index of another substrate, or not a cloud read, joins nothing", () => {
    const azure: JoinLexicon[] = [{ name: "fake", indexIdentity: { ...identity, substrate: "azure" } }];
    const { joins: j } = joinDeclaredToIndex(declared, doc, azure, { regionOf });
    expect(j["east::assets"]).toMatchObject({ verdict: "not-observed", reason: "filtered", detail: expect.stringContaining("reads aws") });
    const engine: IndexDocument = { ...doc, stamp: { ...doc.stamp, source: { kind: "engine", name: "plunge" }, scope: { kind: "engine", engine: "plunge", project: "p", stack: "s" } } };
    const { joins: e } = joinDeclaredToIndex(declared, engine, lexicons, { regionOf });
    expect(e["east::assets"]).toMatchObject({ verdict: "not-observed", reason: "filtered", detail: expect.stringContaining("engine source") });
  });

  test("the verdicts count per row, and each prints its own cell", () => {
    const counts = countJoins(joins, Object.keys(joins));
    expect(counts).toEqual({ bound: 2, absent: 1, "not-observed": 2, "no-binding": 3, ambiguous: 0 });
    expect(joinCell(joins["east::assets"])).toBeUndefined();
    expect(joinCell(joins["east::archive"])).toBe("(absent)");
    expect(joinCell(joins["east::carts"])).toBe("(not observed: filtered)");
    expect(joinCell(joins["east::orders"])).toBe("(no-binding)");
  });

  test("the join does not depend on node order", () => {
    const reversed = joinDeclaredToIndex({ ...declared, nodes: [...declared.nodes].reverse() }, { ...doc, graph: { ...doc.graph, nodes: [...doc.graph.nodes].reverse() } }, lexicons, { regionOf });
    expect(reversed.joins).toEqual(joins);
    expect(reversed.ir.nodes).toEqual(ir.nodes);
  });
});

describe("indexOnlyGraph", () => {
  test("every indexed node is a row, with its native id as its physical id", () => {
    const g = indexOnlyGraph(doc);
    expect(g.nodes.map((n) => n.id)).toEqual(doc.graph.nodes.map((n) => n.id));
    for (const n of g.nodes) expect(n.physicalId).toBe(n.nativeId);
  });
});
