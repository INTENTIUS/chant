import { describe, expect, test } from "vitest";
import { parseDriftDocument, type DriftRecord } from "../drift-record";
import type { DeclaredEntities } from "./deep-observe";
import type { DeclaredIdentity, IndexIdentity } from "./identity-match";
import { diffDeclaredAgainstIndex, indexDriftDocument, INDEX_NOT_OBSERVED, type IndexDriftLexicon } from "./index-drift";
import { indexVersionName } from "./index-document";
import { acceptDeviations, emptyBaseline } from "./observation-baseline";
import { typeListing, type ListedResource, type ListingLexicon, type ListingResult } from "./type-listing";

// #4526: `chant lifecycle diff <env> --index <ref>`, the deep diff of declared
// source against an index version, over fixture indexes typed the way
// behold#1026 writes one (#4521's typeListing), joined as #4525 joins them.

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
const lexicons: IndexDriftLexicon[] = [{ name: "fake", indexIdentity: identity }, { name: "other" }];

const r = (listedType: string, location: string, nativeId: string, properties: Record<string, unknown> = {}): ListedResource => ({
  listedType,
  location,
  nativeId,
  cloudIds: [{ kind: "import-id", value: nativeId }],
  tags: {},
  properties,
  observedAt: "2026-10-26T09:00:01.000Z",
});

function listing(resources: ListedResource[], startedAt = "2026-10-26T09:00:00.000Z"): ListingResult {
  return {
    listing: "v1",
    source: { name: "behold-lister", version: "0.0.0-test" },
    // Kv::Table is outside the scope: the index never looked for one.
    scope: { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: ["Store::Bucket", "Iam::Role", "Queue::Queue"] },
    startedAt,
    completedAt: startedAt.replace(":00.000Z", ":04.000Z"),
    resources,
    coverage: [
      { listedType: "Store::Bucket", location: "us-east-1", verdict: "listed" },
      { listedType: "Iam::Role", location: "global", verdict: "listed" },
      { listedType: "Queue::Queue", location: "us-east-1", verdict: "listed" },
    ],
    notes: [],
  };
}

const bucket = (status: string) => ({ BucketName: "shop-assets", Arn: "arn:aws:s3:::shop-assets", VersioningConfiguration: { Status: status } });

/** The index `chant import --index` read: what source was written from. */
const atImport = typeListing(listing([r("Store::Bucket", "us-east-1", "shop-assets", bucket("Enabled")), r("Iam::Role", "global", "app-runner", { RoleName: "app-runner" })]), typing);

/** A later read, after somebody set versioning to Suspended in the console. */
const afterConsole = typeListing(
  listing([r("Store::Bucket", "us-east-1", "shop-assets", bucket("Suspended")), r("Iam::Role", "global", "app-runner", { RoleName: "app-runner" })], "2026-10-27T10:00:00.000Z"),
  typing,
);

const versionOf = (doc: typeof atImport) => indexVersionName(doc.stamp.observedAt, doc.stamp.digest);

/** Source as the import wrote it: no read-only Arn, every other property as indexed. */
function declared(extra: Array<[string, string, Record<string, unknown>]> = [], lexicon = "fake"): Map<string, DeclaredEntities> {
  const fake: DeclaredEntities = new Map([
    ["assets", { entityType: "Store::Bucket", props: { BucketName: "shop-assets", VersioningConfiguration: { Status: "Enabled" } } }],
    ["runner", { entityType: "Iam::Role", props: { RoleName: "app-runner" } }],
  ]);
  const out = new Map<string, DeclaredEntities>([[lexicon, fake]]);
  for (const [name, type, props] of extra) fake.set(name, { entityType: type, props });
  return out;
}

const run = (doc: typeof atImport, entities = declared(), more: Partial<Parameters<typeof diffDeclaredAgainstIndex>[0]> = {}) =>
  diffDeclaredAgainstIndex({ doc, version: versionOf(doc), entities, lexicons, member: "shop", region: "us-east-1", ...more });

const record = (records: DriftRecord[], address: string) => records.find((x) => x.address === address)!;

describe("diffDeclaredAgainstIndex", () => {
  test("source imported from an index reads back with no drift against that index", () => {
    const res = run(atImport);
    expect(res.counts).toMatchObject({ declared: 2, bound: 2, properties: 0, drifted: 0, pending: 0, notObserved: 0 });
    expect(res.records.map((x) => [x.address, x.status])).toEqual([
      ["assets", "in-sync"],
      ["runner", "in-sync"],
    ]);
    // The read-only Arn is indexed and never declared: somebody else's field, not drift.
    expect(res.byLexicon.fake.deep.unclaimed).toEqual([expect.objectContaining({ name: "assets", fields: [expect.objectContaining({ path: "Arn" })] })]);
  });

  test("a property changed in the console between import and a later read is drift on that declared property", () => {
    const res = run(afterConsole);
    expect(res.counts).toMatchObject({ bound: 2, properties: 1, drifted: 1 });
    const assets = record(res.records, "assets");
    expect(assets).toMatchObject({
      status: "drifted",
      read: "live-read",
      resourceType: "Store::Bucket",
      observedAt: afterConsole.stamp.observedAt,
      attributes: [{ path: "VersioningConfiguration.Status", before: "Enabled", after: "Suspended" }],
    });
    expect(assets.evidence.command).toBe(`chant lifecycle diff --index ${afterConsole.stamp.scopeKey}@${versionOf(afterConsole).replace(/\.json$/, "")}`);
    expect(record(res.records, "runner").status).toBe("in-sync");
  });

  test("an accepted deviation is quiet until the indexed value moves again", () => {
    const baseline = acceptDeviations(emptyBaseline("dev"), "fake", [{ entity: "assets", type: "Store::Bucket", path: "VersioningConfiguration.Status", value: "Suspended" }], {
      now: "2026-10-27T11:00:00.000Z",
    });
    const quiet = run(afterConsole, declared(), { baseline });
    expect(quiet.counts).toMatchObject({ properties: 0, drifted: 0, accepted: 1 });
    expect(record(quiet.records, "assets").status).toBe("in-sync");
    expect(quiet.byLexicon.fake.deep.accepted).toEqual([expect.objectContaining({ name: "assets" })]);

    const movedAgain = typeListing(
      listing([r("Store::Bucket", "us-east-1", "shop-assets", { ...bucket("Enabled"), VersioningConfiguration: { Status: "Disabled" } })], "2026-10-28T10:00:00.000Z"),
      typing,
    );
    const loud = run(movedAgain, declared(), { baseline });
    expect(loud.byLexicon.fake.deep.drifted[0]?.changes[0]).toMatchObject({ path: "VersioningConfiguration.Status", declared: "Enabled", live: "Disabled", baseline: "Suspended" });
    expect(record(loud.records, "assets")).toMatchObject({ status: "drifted", attributes: [{ path: "VersioningConfiguration.Status", before: "Enabled", after: "Disabled" }] });
  });

  test("an entity whose resource the index did not cover is not observed, never diffed", () => {
    const res = run(afterConsole, declared([["sessions", "Kv::Table", { TableName: "sessions", BillingMode: "PAY_PER_REQUEST" }]]));
    const sessions = record(res.records, "sessions");
    expect(sessions).toMatchObject({ status: INDEX_NOT_OBSERVED, unobserved: { reason: "filtered" }, evidence: { engineCode: "not-observed" } });
    expect(sessions.attributes).toBeUndefined();
    expect(res.byLexicon.fake.deep.drifted.map((d) => d.name)).toEqual(["assets"]);
    expect(res.byLexicon.fake.deep.unchanged).not.toContain("sessions");
    expect(res.counts.notObserved).toBe(1);
  });

  test("absent where the index listed the type and location is pending, with the verdict", () => {
    const res = run(atImport, declared([["archive", "Store::Bucket", { BucketName: "never-made" }]]));
    expect(record(res.records, "archive")).toMatchObject({ status: "pending", evidence: { engineCode: "absent" } });
    expect(res.counts.pending).toBe(1);
  });

  test("a row with no identity to join on, or two candidates, is reported with its verdict and never diffed", () => {
    const res = run(atImport, declared([["orders", "Queue::Queue", { QueueName: "orders" }]]));
    expect(record(res.records, "orders")).toMatchObject({ status: "not-observed", unobserved: { reason: "no-binding" }, evidence: { engineCode: "no-binding" } });

    const twice = typeListing(
      {
        ...listing([r("Store::Bucket", "us-east-1", "shop-assets", bucket("Enabled")), r("Store::Bucket", "us-west-2", "shop-assets", bucket("Enabled"))]),
        scope: { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1", "us-west-2"], types: ["Store::Bucket"] },
      },
      typing,
    );
    const amb = diffDeclaredAgainstIndex({ doc: twice, version: versionOf(twice), entities: declared(), lexicons, member: "shop" });
    expect(record(amb.records, "assets")).toMatchObject({ status: "not-observed", unobserved: { reason: "no-binding", detail: expect.stringContaining("none is bound") }, evidence: { engineCode: "ambiguous" } });
    expect(amb.byLexicon.fake.deep.drifted).toEqual([]);
  });

  test("a lexicon with no index match is not observed on every row", () => {
    const res = run(atImport, declared([], "other"));
    expect(res.records.every((x) => x.status === "not-observed" && x.unobserved?.reason === "unsupported-kind")).toBe(true);
    expect(res.counts).toMatchObject({ declared: 2, bound: 0, notObserved: 2 });
  });

  test("a stack's records are addressed as search ids are, and the records are one drift document v1", () => {
    const res = run(afterConsole, declared([["sessions", "Kv::Table", { TableName: "sessions" }]]), { stack: "east" });
    expect(res.records.map((x) => x.address)).toEqual(["east::assets", "east::runner", "east::sessions"]);
    const doc = indexDriftDocument([res], "0.0.0-test");
    expect(doc).toMatchObject({ drift: "v1", chant: "0.0.0-test", counts: { drifted: 1, "in-sync": 1, "not-observed": 1 } });
    expect(parseDriftDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  test("the same index, source and baseline give the same records", () => {
    expect(JSON.stringify(run(afterConsole).records)).toBe(JSON.stringify(run(afterConsole).records));
  });
});
