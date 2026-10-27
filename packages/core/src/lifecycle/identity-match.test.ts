import { describe, expect, test } from "vitest";
import { reconstructIdentityEdges, type IndexedNodeScope } from "../graph-refs";
import type { IRNode } from "../graph-ir";
import { deriveEdges, indexedNodeScope, type EdgeLexicon } from "./derive-edges";
import { indexCoverageVerdict, matchDeclaredToIndex, type DeclaredIdentity, type IndexIdentity } from "./identity-match";
import type { IndexDocument } from "./index-document";
import { typeListing, type ListedResource, type ListingLexicon, type ListingResult } from "./type-listing";

// #4523: the tier-2 rule from INTENTIUS/behold#1025's design comment, with
// the join rules ruled on INTENTIUS/behold#1023 (2026-10-26).

/** A fake lexicon's identity table: type -> its identifying props, or why it has none. */
const IDENTITY: Record<string, { parts?: string[]; serverAssigned?: boolean; global?: boolean }> = {
  "Store::Bucket": { parts: ["BucketName"] },
  "Iam::Role": { parts: ["RoleName"], global: true },
  "Queue::Queue": { parts: ["QueueUrl"], serverAssigned: true },
  "Kv::Table": { parts: ["TableName"] },
  "Net::Route": { parts: ["RouteTableId", "DestinationCidrBlock"] },
};

const identity: IndexIdentity = {
  substrate: "aws",
  declaredIdentity(entityType, props): DeclaredIdentity {
    const row = IDENTITY[entityType];
    if (!row?.parts) return { kind: "unmatchable", reason: "unsupported-kind", detail: `${entityType} has no primary identifier on record` };
    if (row.serverAssigned) return { kind: "unmatchable", reason: "no-binding", detail: `${entityType} ${row.parts.join(", ")} is assigned by the service` };
    const values: string[] = [];
    for (const p of row.parts) {
      const v = props[p];
      if (typeof v !== "string" || v === "") return { kind: "unmatchable", reason: "no-binding", detail: "identity is not in the declaration" };
      values.push(v);
    }
    return { kind: "identifier", listedType: entityType, identifier: values.join("|"), global: row.global === true };
  },
};

const KINDS = [...Object.keys(IDENTITY), "Store::BucketPolicy", "Fn::Function", "Logs::Group"];
const typing: ListingLexicon[] = [{ name: "fake", listedTypes: { substrate: "aws", kindFor: (t) => (KINDS.includes(t) ? t : undefined) } }];

const r = (listedType: string, location: string, nativeId: string, properties: Record<string, unknown> = {}, extra: Partial<ListedResource> = {}): ListedResource => ({
  listedType,
  location,
  nativeId,
  cloudIds: [{ kind: "import-id", value: nativeId }],
  tags: {},
  properties,
  observedAt: "2026-10-26T09:00:01.000Z",
  ...extra,
});

function listing(resources: ListedResource[], extra: Partial<ListingResult> = {}): ListingResult {
  return {
    listing: "v1",
    source: { name: "behold-lister", version: "0.0.0-test" },
    scope: { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1", "us-west-2"], types: ["Store::Bucket", "Iam::Role", "Queue::Queue", "Net::Route"] },
    startedAt: "2026-10-26T09:00:00.000Z",
    completedAt: "2026-10-26T09:00:04.000Z",
    resources,
    coverage: [
      { listedType: "Store::Bucket", location: "us-east-1", verdict: "listed" },
      { listedType: "Store::Bucket", location: "us-west-2", verdict: "listed" },
      { listedType: "Iam::Role", location: "global", verdict: "listed" },
      { listedType: "Queue::Queue", location: "us-east-1", verdict: "listed" },
      { listedType: "Net::Route", location: "us-east-1", verdict: "read-failed", detail: "ListResources AWS::EC2::Route needs a RouteTableId" },
    ],
    notes: [],
    ...extra,
  };
}

const RESOURCES: ListedResource[] = [
  r("Store::Bucket", "us-east-1", "shop-assets", { BucketName: "shop-assets" }),
  // The same name in another region (a second listing of a global-namespace type, or a replica).
  r("Store::Bucket", "us-west-2", "shop-assets", { BucketName: "shop-assets" }),
  r("Store::Bucket", "us-east-1", "shop-logs", { BucketName: "shop-logs" }),
  r("Iam::Role", "global", "app-runner", { RoleName: "app-runner" }, { cloudIds: [{ kind: "arn", value: "arn:aws:iam::000000000000:role/app-runner" }] }),
  r("Queue::Queue", "us-east-1", "https://sqs.us-east-1.amazonaws.com/000000000000/orders", { QueueName: "orders" }),
];

const doc = typeListing(listing(RESOURCES), typing);
const id = (location: string, type: string, nativeId: string) => `aws/000000000000/${location}/${type}/${nativeId}`;
const declared = (name: string, entityType: string, props: Record<string, unknown>, region?: string) => ({ name, entityType, props, ...(region ? { region } : {}) });

describe("matchDeclaredToIndex", () => {
  const { matches } = matchDeclaredToIndex(
    [
      declared("assets", "Store::Bucket", { BucketName: "shop-assets" }),
      declared("runner", "Iam::Role", { RoleName: "app-runner" }),
      declared("missing", "Store::Bucket", { BucketName: "shop-never-made" }),
      declared("orders", "Queue::Queue", { QueueName: "orders" }),
      declared("table", "Kv::Table", { TableName: "carts" }),
      declared("route", "Net::Route", { RouteTableId: "rtb-1", DestinationCidrBlock: "0.0.0.0/0" }),
      declared("byRef", "Store::Bucket", { BucketName: { Ref: "Name" } }),
      declared("unknown", "Made::Up", { Name: "x" }),
    ],
    [doc],
    identity,
    { region: "us-east-1" },
  );

  test("one node binds, by the identifier the declaration spells", () => {
    expect(matches.assets).toMatchObject({ verdict: "bound", node: id("us-east-1", "Store::Bucket", "shop-assets"), nativeId: "shop-assets", location: "us-east-1" });
  });

  test("a global type binds at location global, whatever the entity's region", () => {
    expect(matches.runner).toMatchObject({ verdict: "bound", node: id("global", "Iam::Role", "app-runner"), location: "global" });
  });

  test("no node where the index listed the type in that region is absent", () => {
    expect(matches.missing).toEqual({
      entity: "missing",
      entityType: "Store::Bucket",
      verdict: "absent",
      identifier: "shop-never-made",
      listedType: "Store::Bucket",
      location: "us-east-1",
    });
  });

  test("a server-assigned identity cannot match: not observed, no-binding", () => {
    expect(matches.orders).toMatchObject({ verdict: "not-observed", reason: "no-binding" });
    expect(matches.byRef).toMatchObject({ verdict: "not-observed", reason: "no-binding", detail: "identity is not in the declaration" });
  });

  test("a type outside the index's scope is not observed (filtered), never absent", () => {
    expect(matches.table).toMatchObject({ verdict: "not-observed", reason: "filtered", listedType: "Kv::Table", location: "us-east-1" });
    expect(matches.table.verdict).not.toBe("absent");
  });

  test("coverage that did not list carries its own reason and detail", () => {
    expect(matches.route).toMatchObject({
      verdict: "not-observed",
      reason: "read-failed",
      detail: "ListResources AWS::EC2::Route needs a RouteTableId",
      identifier: "rtb-1|0.0.0.0/0",
    });
  });

  test("a type with no identity on record is unsupported", () => {
    expect(matches.unknown).toMatchObject({ verdict: "not-observed", reason: "unsupported-kind" });
  });

  test("two candidates are refused, naming both, and nothing binds", () => {
    const { matches: m } = matchDeclaredToIndex([declared("assets", "Store::Bucket", { BucketName: "shop-assets" })], [doc], identity);
    expect(m.assets).toMatchObject({
      verdict: "refused",
      candidates: [id("us-east-1", "Store::Bucket", "shop-assets"), id("us-west-2", "Store::Bucket", "shop-assets")],
    });
    expect(m.assets.verdict === "refused" && m.assets.detail).toContain(id("us-west-2", "Store::Bucket", "shop-assets"));
  });

  test("the entity's own region wins over the option", () => {
    const { matches: m } = matchDeclaredToIndex([declared("west", "Store::Bucket", { BucketName: "shop-assets" }, "us-west-2")], [doc], identity, { region: "us-east-1" });
    expect(m.west).toMatchObject({ verdict: "bound", node: id("us-west-2", "Store::Bucket", "shop-assets") });
  });

  test("with no region a miss cannot be scoped, so it is not observed", () => {
    const { matches: m } = matchDeclaredToIndex([declared("missing", "Store::Bucket", { BucketName: "shop-never-made" })], [doc], identity);
    expect(m.missing).toMatchObject({ verdict: "not-observed", reason: "no-binding" });
  });

  test("a region the index never read is not observed (filtered)", () => {
    const { matches: m } = matchDeclaredToIndex([declared("eu", "Store::Bucket", { BucketName: "shop-never-made" }, "eu-west-1")], [doc], identity);
    expect(m.eu).toMatchObject({ verdict: "not-observed", reason: "filtered", location: "eu-west-1" });
  });

  test("the verdict does not depend on node order", () => {
    const shuffled: IndexDocument = { ...doc, graph: { ...doc.graph, nodes: [...doc.graph.nodes].reverse() } };
    const ents = [declared("assets", "Store::Bucket", { BucketName: "shop-assets" }), declared("missing", "Store::Bucket", { BucketName: "x-never" })];
    expect(matchDeclaredToIndex(ents, [shuffled], identity)).toEqual(matchDeclaredToIndex(ents, [doc], identity));
  });

  test("documents from two accounts or two reads are refused", () => {
    const other = typeListing(listing(RESOURCES, { scope: { substrate: "aws", scopeId: "111111111111", locations: ["us-east-1"], types: "*" } }), typing);
    expect(() => matchDeclaredToIndex([], [doc, other], identity)).toThrow(/one account/);
    const later = typeListing(listing(RESOURCES, { startedAt: "2026-10-26T10:00:00.000Z" }), typing);
    expect(() => matchDeclaredToIndex([], [doc, later], identity)).toThrow(/one read/);
  });
});

describe("indexCoverageVerdict", () => {
  test('"*" in coverage matches every type and location', () => {
    const wild = typeListing(listing([], { scope: { substrate: "aws", scopeId: "000000000000", locations: "*", types: "*" }, coverage: [{ listedType: "*", location: "*", verdict: "listed" }] }), typing);
    expect(indexCoverageVerdict([wild], "Kv::Table", "ap-south-1")).toEqual({ listed: true });
  });

  test("an exact refusal beats a wildcard listing", () => {
    const mixed = typeListing(
      listing([], {
        scope: { substrate: "aws", scopeId: "000000000000", locations: "*", types: "*" },
        coverage: [
          { listedType: "*", location: "*", verdict: "listed" },
          { listedType: "Kv::Table", location: "us-east-1", verdict: "no-credentials", detail: "AccessDenied on dynamodb:ListTables" },
        ],
      }),
      typing,
    );
    expect(indexCoverageVerdict([mixed], "Kv::Table", "us-east-1")).toEqual({ listed: false, reason: "no-credentials", detail: "AccessDenied on dynamodb:ListTables" });
  });

  test("a tag-filtered read cannot say absent", () => {
    const tagged = typeListing(listing([], { scope: { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: "*", tagFilter: { team: "shop" } }, coverage: [{ listedType: "*", location: "*", verdict: "listed" }] }), typing);
    expect(indexCoverageVerdict([tagged], "Store::Bucket", "us-east-1")).toMatchObject({ listed: false, reason: "filtered" });
  });

  test("in scope with no coverage entry is not reached", () => {
    const bare = typeListing(listing([], { coverage: [] }), typing);
    expect(indexCoverageVerdict([bare], "Store::Bucket", "us-east-1")).toMatchObject({ listed: false, reason: "not-reached" });
  });
});

describe("the identity-match pass", () => {
  const holders: ListedResource[] = [
    r("Store::Bucket", "us-east-1", "shop-assets", { BucketName: "shop-assets" }),
    r("Store::Bucket", "us-west-2", "shop-assets", { BucketName: "shop-assets" }),
    r("Logs::Group", "us-east-1", "shop-assets", { LogGroupName: "shop-assets" }),
    r("Iam::Role", "global", "app-runner", { RoleName: "app-runner" }, { cloudIds: [{ kind: "arn", value: "arn:aws:iam::000000000000:role/app-runner" }] }),
    r("Fn::Function", "us-east-1", "resize", {
      FunctionName: "resize",
      Role: "arn:aws:iam::000000000000:role/app-runner",
      Environment: { Variables: { LOG_BUCKET: "shop-logs" } },
      Tags: [{ Key: "bucket", Value: "shop-logs" }],
    }),
    r("Store::Bucket", "us-east-1", "shop-logs", { BucketName: "shop-logs" }),
    r("Store::BucketPolicy", "us-east-1", "shop-logs-policy", { Bucket: "shop-logs" }),
    // Names the bucket that exists in two regions, and a log group of the same name in its own: ambiguous.
    r("Fn::Function", "us-east-1", "thumbs", { FunctionName: "thumbs", Environment: { Variables: { ASSETS: "shop-assets" } } }),
    // In us-west-2, the bucket name reaches only the us-west-2 bucket.
    r("Fn::Function", "us-west-2", "mirror", { FunctionName: "mirror", Environment: { Variables: { ASSETS: "shop-assets" } } }),
  ];
  const typed = typeListing(
    listing(holders, { scope: { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1", "us-west-2"], types: "*" }, coverage: [{ listedType: "*", location: "*", verdict: "listed" }] }),
    typing,
  );
  const lexicons: EdgeLexicon[] = [
    {
      name: "fake",
      referenceCatalog: { identities: [{ kind: "Store::Bucket", ids: ["BucketName"] }], refs: [{ from: "Store::BucketPolicy", path: "Bucket", targetKind: "Store::Bucket", relation: "reference" }] },
      indexIdentity: identity,
    },
  ];
  const out = deriveEdges(typed, lexicons);
  const identityEdges = out.graph.edges.filter((e) => e.rule?.startsWith("identity-match:"));

  test("an attribute equal to another node's identity draws an identity-match edge", () => {
    expect(identityEdges).toContainEqual({
      from: id("us-east-1", "Fn::Function", "resize"),
      to: id("global", "Iam::Role", "app-runner"),
      kind: "ref",
      viaAttr: "Role",
      grain: "property",
      origin: "derived",
      rule: "identity-match:fake:Iam::Role:arn",
      relation: "reference",
    });
    expect(identityEdges).toContainEqual(
      expect.objectContaining({ from: id("us-east-1", "Fn::Function", "resize"), to: id("us-east-1", "Store::Bucket", "shop-logs"), viaAttr: "Environment", rule: "identity-match:fake:Store::Bucket:native-id" }),
    );
  });

  test("the join key is scoped to the holder's region", () => {
    expect(identityEdges).toContainEqual(
      expect.objectContaining({ from: id("us-west-2", "Fn::Function", "mirror"), to: id("us-west-2", "Store::Bucket", "shop-assets") }),
    );
    expect(identityEdges.some((e) => e.from === id("us-west-2", "Fn::Function", "mirror") && e.to.includes("/us-east-1/"))).toBe(false);
  });

  test("a value naming two nodes draws no edge and the note names every candidate", () => {
    const thumbs = id("us-east-1", "Fn::Function", "thumbs");
    expect(out.graph.edges.some((e) => e.from === thumbs)).toBe(false);
    const note = out.notes?.find((n) => n.kind === "ambiguous-identity" && n.message.startsWith(thumbs));
    expect(note?.message).toContain(id("us-east-1", "Store::Bucket", "shop-assets"));
    expect(note?.message).toContain(id("us-east-1", "Logs::Group", "shop-assets"));
  });

  test("a pair the catalog already joined gets no identity-match edge", () => {
    const policy = id("us-east-1", "Store::BucketPolicy", "shop-logs-policy");
    const fromPolicy = out.graph.edges.filter((e) => e.from === policy);
    expect(fromPolicy).toHaveLength(1);
    expect(fromPolicy[0].rule).toBe("fake:Store::BucketPolicy:Bucket");
  });

  test("tags are never read by the identity pass", () => {
    const resize = id("us-east-1", "Fn::Function", "resize");
    expect(identityEdges.some((e) => e.from === resize && e.viaAttr === "Tags")).toBe(false);
  });

  test("a node's own identity is not a reference to itself", () => {
    for (const e of identityEdges) expect(e.from).not.toBe(e.to);
  });

  test("re-deriving gives the same document", () => {
    expect(deriveEdges(out, lexicons)).toEqual(out);
  });

  test("node order does not change the edges or the ambiguities", () => {
    const scopeOf = (n: IRNode): IndexedNodeScope => indexedNodeScope(typed, n);
    const nodes = typed.graph.nodes;
    const forward = reconstructIdentityEdges(nodes, [{ lexicon: "fake" }], scopeOf);
    const backward = reconstructIdentityEdges([...nodes].reverse(), [{ lexicon: "fake" }], scopeOf);
    expect(backward).toEqual(forward);
  });

  test("without an indexIdentity the pass draws nothing", () => {
    const plain = deriveEdges(typed, [{ name: "fake", referenceCatalog: lexicons[0].referenceCatalog }]);
    expect(plain.graph.edges.some((e) => e.rule?.startsWith("identity-match:"))).toBe(false);
  });
});
