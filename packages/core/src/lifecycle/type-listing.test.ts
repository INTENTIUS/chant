import { describe, expect, test } from "vitest";
import { MASKED } from "../deep-observation";
import { indexCoverageFor, validateIndexDocument } from "./index-document";
import { listedNodeId, typeListing, type ListingLexicon, type ListingResult } from "./type-listing";

// #4521: a listing (behold#1029's shape) typed into an index version (behold#1025).
const lexicons: ListingLexicon[] = [
  {
    name: "aws",
    listedTypes: { substrate: "aws", kindFor: (t) => (t === "AWS::S3::Bucket" || t === "AWS::RDS::DBInstance" ? t : undefined) },
    deepNormalizationHooks: {
      // Stands in for a lexicon noise rule: an ARN is server-populated.
      prune: (node) => node.side === "live" && node.key === "Arn",
    },
  },
  {
    name: "k8s",
    listedTypes: {
      substrate: "kubernetes",
      kindFor: (t) => (t === "apps/v1/Deployment" ? "K8s::Apps::Deployment" : undefined),
      observedTree: ({ apiVersion: _a, kind: _k, ...rest }) => rest,
    },
  },
];

function listing(overrides: Partial<ListingResult> = {}): ListingResult {
  return {
    listing: "v1",
    source: { name: "behold-lister", version: "0.0.0-test" },
    scope: { substrate: "aws", scopeId: "123456789012", locations: ["us-east-1"], types: "*" },
    startedAt: "2026-10-26T09:14:03.120Z",
    completedAt: "2026-10-26T09:14:09.000Z",
    resources: [
      {
        listedType: "AWS::S3::Bucket",
        location: "us-east-1",
        nativeId: "assets-bucket",
        cloudIds: [{ kind: "import-id", value: "assets-bucket" }],
        tags: { team: "web", "api-token": "<masked>" },
        properties: { BucketName: "assets-bucket", Arn: "arn:aws:s3:::assets-bucket", Tags: [{ Key: "team", Value: "web" }] },
        observedAt: "2026-10-26T09:14:04.000Z",
        facts: { cloudIds: [{ kind: "import-id", value: "assets-bucket" }], observedAt: "2026-10-26T09:14:04.000Z", markers: { owner: "web", encoding: "plain", source: "live" } },
      },
      {
        listedType: "AWS::Pipes::Pipe",
        location: "us-east-1",
        nativeId: "orders-pipe",
        cloudIds: [{ kind: "import-id", value: "orders-pipe" }],
        tags: {},
        properties: { Name: "orders-pipe", SourceParameters: { ClientSecret: "plain-text-if-the-lister-missed-it" } },
        observedAt: "2026-10-26T09:14:05.000Z",
      },
    ],
    coverage: [
      { listedType: "AWS::S3::Bucket", location: "us-east-1", verdict: "listed" },
      { listedType: "AWS::Pipes::Pipe", location: "us-east-1", verdict: "listed" },
    ],
    notes: [{ code: "default-types", message: "types * listed the default set" }],
    ...overrides,
  };
}

describe("typeListing", () => {
  test("a mapped type becomes a typed node with its lexicon's normalization", () => {
    const doc = typeListing(listing(), lexicons);
    const bucket = doc.graph.nodes.find((n) => n.listedType === "AWS::S3::Bucket")!;
    expect(bucket).toMatchObject({
      id: "aws/123456789012/us-east-1/AWS::S3::Bucket/assets-bucket",
      kind: "AWS::S3::Bucket",
      lexicon: "aws",
      location: "us-east-1",
      nativeId: "assets-bucket",
      physicalId: "assets-bucket",
    });
    expect(bucket.unmappedKind).toBeUndefined();
    // The hook pruned Arn; the rest is key-sorted as the deep path leaves it.
    expect(bucket.attrs).toEqual({ BucketName: "assets-bucket", Tags: [{ Key: "team", Value: "web" }] });
    expect(bucket.facts).toEqual({
      markers: { owner: "web", encoding: "plain", source: "live" },
      cloudIds: [{ kind: "import-id", value: "assets-bucket" }],
      observedAt: "2026-10-26T09:14:04.000Z",
    });
  });

  test("an unmapped type is kept as an unknown-kind node, never dropped, and named in a note", () => {
    const input = listing();
    const doc = typeListing(input, lexicons);
    // Every listed object is a node: the count is the guard against a drop.
    expect(doc.graph.nodes).toHaveLength(input.resources.length);
    const pipe = doc.graph.nodes.find((n) => n.listedType === "AWS::Pipes::Pipe");
    expect(pipe).toBeDefined();
    expect(pipe).toMatchObject({ kind: "AWS::Pipes::Pipe", lexicon: "aws", unmappedKind: true, nativeId: "orders-pipe" });
    expect(doc.notes?.filter((n) => n.kind === "unmapped-type").map((n) => n.listedType)).toEqual(["AWS::Pipes::Pipe"]);
  });

  test("secrets are masked with the snapshot path's one list, on mapped and unmapped nodes and on tags", () => {
    const doc = typeListing(listing(), lexicons);
    const pipe = doc.graph.nodes.find((n) => n.listedType === "AWS::Pipes::Pipe")!;
    expect((pipe.attrs.SourceParameters as Record<string, unknown>).ClientSecret).toBe(MASKED);
    const bucket = doc.graph.nodes.find((n) => n.listedType === "AWS::S3::Bucket")!;
    expect(bucket.tags).toEqual({ "api-token": MASKED, team: "web" });
    expect(JSON.stringify(doc)).not.toContain("plain-text-if-the-lister-missed-it");
  });

  test("a lexicon's observed-tree reshape runs before its hooks", () => {
    const doc = typeListing(
      listing({
        scope: { substrate: "kubernetes", scopeId: "kind-dev", locations: "*", types: "*" },
        resources: [
          {
            listedType: "apps/v1/Deployment",
            location: "web",
            nativeId: "web/frontend",
            cloudIds: [{ kind: "k8s-uid", value: "0d6f..." }],
            tags: {},
            properties: { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "frontend", namespace: "web" }, spec: { replicas: 2 } },
            observedAt: "2026-10-26T09:14:04.000Z",
          },
        ],
        coverage: [{ listedType: "*", location: "*", verdict: "listed" }],
        notes: [],
      }),
      lexicons,
    );
    const [deploy] = doc.graph.nodes;
    expect(deploy.id).toBe("kubernetes/kind-dev/web/apps%2Fv1%2FDeployment/web/frontend");
    expect(deploy.kind).toBe("K8s::Apps::Deployment");
    expect(deploy.attrs).toEqual({ metadata: { name: "frontend", namespace: "web" }, spec: { replicas: 2 } });
  });

  test("the document is stamped with the listing's scope and validates", () => {
    const doc = typeListing(listing(), lexicons);
    expect(() => validateIndexDocument(doc)).not.toThrow();
    expect(doc.stamp.source).toEqual({ kind: "cloud", name: "behold-lister", version: "0.0.0-test" });
    expect(doc.stamp.observedAt).toBe("2026-10-26T09:14:03.120Z");
    expect(doc.stamp.scope).toEqual({ kind: "cloud", substrate: "aws", scopeId: "123456789012", locations: ["us-east-1"], types: "*" });
    expect(doc.graph.edges).toEqual([]);
    expect(doc.notes?.map((n) => n.kind)).toEqual(["default-types", "unmapped-type"]);
  });

  test("the same listing in another order gives the same document", () => {
    const a = listing();
    const b = listing({ resources: [...a.resources].reverse() });
    expect(typeListing(b, [...lexicons].reverse())).toEqual(typeListing(a, lexicons));
  });

  test("the node id matches behold's listedNodeId: % and / escaped in the first four parts, the native id raw", () => {
    expect(
      listedNodeId({ substrate: "azure", scopeId: "sub-1", location: "eastus", listedType: "microsoft.storage/storageaccounts", nativeId: "/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/st1" }),
    ).toBe("azure/sub-1/eastus/microsoft.storage%2Fstorageaccounts//subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/st1");
  });
});

describe("indexCoverageFor", () => {
  test('"*" matches every type or location, and an exact entry wins', () => {
    const coverage = [
      { listedType: "*", location: "*", verdict: "listed" as const },
      { listedType: "microsoft.web/sites", location: "*", verdict: "no-credentials" as const },
      { listedType: "microsoft.web/sites", location: "westeurope", verdict: "read-failed" as const },
    ];
    expect(indexCoverageFor(coverage, "microsoft.storage/storageaccounts", "eastus")?.verdict).toBe("listed");
    expect(indexCoverageFor(coverage, "microsoft.web/sites", "eastus")?.verdict).toBe("no-credentials");
    expect(indexCoverageFor(coverage, "microsoft.web/sites", "westeurope")?.verdict).toBe("read-failed");
    expect(indexCoverageFor([{ listedType: "AWS::S3::Bucket", location: "us-east-1", verdict: "listed" }], "AWS::S3::Bucket", "us-west-2")).toBeUndefined();
  });
});
