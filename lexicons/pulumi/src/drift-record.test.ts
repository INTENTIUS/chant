/**
 * The Pulumi drift adapter (#4453): `pulumi refresh --preview-only --json
 * --target <urn>` into drift records, read `refresh`.
 *
 * The documents in `testdata/pulumi-refresh` are recorded (#4475, see its
 * README): pulumi 3.272.0 against the plunge corpus's aws-ts stack on floci,
 * after four out-of-band edits through floci's own API: a tag on the site
 * bucket changed, the bucket policy deleted, the SecureString parameter
 * overwritten (floci drops its tags when it does) and the events queue's
 * retention lowered. `stack-export.json` is the stack before the edits.
 * Nothing here runs Pulumi.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { driftDocument } from "@intentius/chant/drift-record";
import { contract } from "../../../packages/core/src/workspace/__fixtures__/contract-repo";
import schema from "../../../packages/core/src/workspace/drift.schema.json";
import { plungeDriftArgs, plungeDriftStreamRecords, pulumiRefreshArgs, pulumiRefreshDocumentRecords, pulumiRefreshDriftRecords } from "./drift-record";
import { readPulumiMember } from "./workspace-member";

const dir = join(import.meta.dirname, "testdata", "pulumi-refresh");
const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf-8"));
const urn = (type: string, name: string) => `urn:pulumi:floci::corpus-aws-ts::${type}::${name}`;
const BUCKET = urn("aws:s3/bucket:Bucket", "site-bucket");
const ROLE = urn("aws:iam/role:Role", "app-role");
const GONE = urn("aws:s3/bucketPolicy:BucketPolicy", "site-bucket-policy");
const DBPW = urn("aws:ssm/parameter:Parameter", "db-password");
const EVENTS = urn("aws:sqs/queue:Queue", "events");
const ASSETS = urn("corpus:index:Site$aws:s3/bucket:Bucket", "docs-assets");

const observedAt = "2026-10-26T05:30:00Z";
// The member graph of the recorded export: node keys ignore stack and project.
const graph = { member: null, at: null, ids: [...readPulumiMember({ member: { dir, label: "site" } }).entities.keys()] };

const { expectValid } = contract(schema);

function records() {
  return pulumiRefreshDriftRecords({
    member: "site",
    observedAt,
    graph,
    stack: "floci",
    reads: [
      { urn: BUCKET, refresh: read("bucket-edited.json") },
      { urn: ROLE, refresh: read("role-same.json") },
      { urn: GONE, refresh: read("policy-deleted.json") },
      { urn: DBPW, refresh: read("secret-edited.json") },
      { urn: EVENTS, refresh: read("queue-edited.json") },
    ],
  });
}
const at = (address: string) => records().find((r) => r.address === address)!;

describe("pulumi refresh --preview-only --json to drift records (#4453)", () => {
  test("the argv: one resource, preview only, JSON", () => {
    expect(pulumiRefreshArgs({ urn: BUCKET, stack: "floci" })).toEqual(["refresh", "--preview-only", "--json", "--stack", "floci", "--target", BUCKET]);
    expect(pulumiRefreshArgs()).toEqual(["refresh", "--preview-only", "--json"]);
  });

  test("an out-of-band edit yields a drifted record with the detailedDiff paths, state before, provider after", () => {
    const bucket = at(BUCKET);
    expect(bucket).toMatchObject({
      member: "site",
      engine: "pulumi",
      address: BUCKET,
      resourceType: "aws:s3/bucket:Bucket",
      node: "site/aws:s3/bucket:Bucket::site-bucket",
      observedAt,
      read: "refresh",
      status: "drifted",
      evidence: { tool: "pulumi", command: `pulumi refresh --preview-only --json --stack floci --target ${BUCKET}`, engineCode: "update" },
    });
    // Pulumi's property paths as printed. The provider also names replicationConfiguration.role, null on both sides.
    expect(bucket.attributes).toEqual([
      { path: "replicationConfiguration.role" },
      { path: 'tagsAll["corpus-owner"]', before: "plunge", after: "hotfix" },
      { path: 'tags["corpus-owner"]', before: "plunge", after: "hotfix" },
    ]);
    expect(at(EVENTS).attributes).toEqual([{ path: "messageRetentionSeconds", before: 3600, after: 600 }]);
  });

  test("an unchanged resource prints a refresh step and is in-sync; a delete is missing", () => {
    expect(at(ROLE)).toMatchObject({ status: "in-sync", node: "site/aws:iam/role:Role::app-role", evidence: { engineCode: "refresh" } });
    expect(at(ROLE).attributes).toBeUndefined();
    expect(at(GONE)).toMatchObject({ status: "missing", node: "site/aws:s3/bucketPolicy:BucketPolicy::site-bucket-policy", evidence: { engineCode: "delete" } });
  });

  test("a blinded secret is sensitive, with neither side; a path only the inputs hold reads the inputs", () => {
    expect(at(DBPW).status).toBe("drifted");
    expect(at(DBPW).attributes).toEqual([
      { path: 'tagsAll["corpus-owner"]', before: "plunge" },
      { path: 'tagsAll["corpus-program"]', before: "aws-ts" },
      { path: 'tags["corpus-owner"]', before: "plunge" },
      { path: 'tags["corpus-program"]', before: "aws-ts" },
      { path: "value", sensitive: true },
      { path: "version", before: 1, after: 2 },
    ]);
    expect(JSON.stringify(at(DBPW))).not.toContain("[secret]");
  });

  test("a refresh step with both states and no diff is compared on its outputs", () => {
    // Derived from the recorded role-same.json: the same refresh step with one output moved.
    const doc = JSON.parse(JSON.stringify(read("role-same.json"))) as { steps: { newState: { outputs: Record<string, unknown> } }[] };
    doc.steps[0].newState.outputs.maxSessionDuration = 7200;
    const [moved] = pulumiRefreshDriftRecords({ member: "site", observedAt, graph, reads: [{ urn: ROLE, refresh: doc }] });
    expect(moved.status).toBe("drifted");
    expect(moved.attributes).toEqual([{ path: "maxSessionDuration", before: 3600, after: 7200 }]);
  });

  test("a target the refresh printed nothing for is not-reached; a failed run carries its reason", () => {
    // Records come back sorted by address, so the role (aws:iam) is first.
    const [failed, none] = pulumiRefreshDriftRecords({
      member: "site",
      observedAt,
      reads: [
        { urn: BUCKET, refresh: read("role-same.json") },
        { urn: ROLE, failed: { reason: "no-credentials", detail: "error: no credentials" } },
      ],
    });
    expect(none).toMatchObject({ address: BUCKET, status: "not-observed", unobserved: { reason: "not-reached", queried: BUCKET } });
    expect(failed).toMatchObject({ address: ROLE, status: "not-observed", unobserved: { reason: "no-credentials", detail: "error: no credentials", queried: ROLE } });
    expect(failed.node).toBeNull();
  });

  test("records are sorted by address and make a valid drift document", () => {
    const list = records();
    expect(list.map((r) => r.address)).toEqual([...list.map((r) => r.address)].sort());
    const doc = driftDocument(list);
    expectValid(doc);
    expect(doc.counts).toMatchObject({ drifted: 3, "in-sync": 1, missing: 1 });
  });

  test("an untargeted refresh gives a record per resource, the stack and providers left out", () => {
    const list = pulumiRefreshDocumentRecords({ member: "site", observedAt, refresh: read("all.json") });
    expect(list).toHaveLength(15);
    expect(list.filter((r) => r.status !== "in-sync").map((r) => [r.address, r.status])).toEqual(
      [
        [DBPW, "drifted"],
        [urn("aws:ssm/parameter:Parameter", "vpc-id"), "drifted"],
        [GONE, "missing"],
        [EVENTS, "drifted"],
        [BUCKET, "drifted"],
      ].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    );
    expect(list[0].evidence.command).toBe("pulumi refresh --preview-only --json");
    expect(() => pulumiRefreshDocumentRecords({ member: "site", observedAt, refresh: {} })).toThrow(/no top-level "steps"/);
  });
});

describe("a member on plunge: plunge drift --resource <urn> --stream through chant's decoder (#4453)", () => {
  // Recorded from plunge v0.1.0-dev.0 (pulumi 3.272.0 compatible) on floci; settled-empty.ndjson is derived (README).
  const stream = (name: string) => readFileSync(join(import.meta.dirname, "testdata", "plunge-drift", name), "utf-8");

  test("the argv: one resource, streamed", () => {
    expect(plungeDriftArgs({ urn: ASSETS, stack: "floci", member: "site" })).toEqual(["drift", "--resource", ASSETS, "--stream", "--stack", "floci", "--member", "site"]);
  });

  test("the stream's records keep plunge's verdict and get their node from the URN rule", () => {
    const list = plungeDriftStreamRecords({
      member: "site",
      observedAt,
      graph,
      reads: [
        { urn: ASSETS, stream: stream("assets-drifted.ndjson") },
        { urn: ROLE, stream: stream("role-in-sync.ndjson") },
      ],
    });
    expect(list.map((r) => [r.address, r.engine, r.read, r.status, r.node])).toEqual([
      [ROLE, "plunge", "refresh", "in-sync", "site/aws:iam/role:Role::app-role"],
      [ASSETS, "plunge", "refresh", "drifted", "site/corpus:index:Site$aws:s3/bucket:Bucket::docs-assets"],
    ]);
    expect(list.find((r) => r.address === ASSETS)!.attributes).toEqual([
      { path: 'tagsAll["corpus-owner"]', before: "plunge", after: "hotfix" },
      { path: 'tags["corpus-owner"]', before: "plunge", after: "hotfix" },
    ]);
    expect(list.find((r) => r.address === ASSETS)!.evidence).toMatchObject({ tool: "plunge", version: "v0.1.0-dev.0" });
    expectValid(driftDocument(list));
  });

  test("a stream that settles without the URN is not-reached; one that does not decode, or a failed run, is not-observed", () => {
    const [empty] = plungeDriftStreamRecords({ member: "site", observedAt, graph, reads: [{ urn: ROLE, stream: stream("settled-empty.ndjson") }] });
    expect(empty).toMatchObject({ address: ROLE, engine: "plunge", status: "not-observed", unobserved: { reason: "not-reached" }, node: "site/aws:iam/role:Role::app-role" });
    // Sorted by address: the role (aws:iam) before the bucket (corpus:index).
    const [failed, garbled] = plungeDriftStreamRecords({
      member: "site",
      observedAt,
      reads: [
        { urn: ASSETS, stream: "not json\n" },
        // What plunge prints for a URN the stack holds no record for, exit 1 (recorded).
        { urn: ROLE, failed: { reason: "read-failed", detail: "error: plunge: the stack holds no record for " + ROLE } },
      ],
    });
    expect(garbled).toMatchObject({ address: ASSETS, status: "not-observed", unobserved: { reason: "read-failed", detail: expect.stringMatching(/did not decode/) } });
    expect(failed).toMatchObject({ address: ROLE, status: "not-observed", unobserved: { reason: "read-failed", detail: expect.stringMatching(/holds no record/) } });
  });
});
