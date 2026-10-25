/**
 * The Pulumi drift adapter (#4453): `pulumi refresh --preview-only --json
 * --target <urn>` into drift records, read `refresh`.
 *
 * The documents in `testdata/pulumi-refresh` are hand-written to the
 * documented `--json` shape (`steps[].op/urn/oldState/newState/detailedDiff`),
 * not recorded from a real run. `bucket-edited.json` is an out-of-band edit:
 * someone made the bucket public and changed a tag in the console. Nothing
 * here runs Pulumi.
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
const urn = (type: string, name: string) => `urn:pulumi:dev::site::${type}::${name}`;
const ASSETS = urn("aws:s3/bucket:Bucket", "assets");
const ROLE = urn("aws:iam/role:Role", "web");
const GONE = urn("aws:iam/rolePolicy:RolePolicy", "webReadsAssets");
const DBPW = urn("aws:ssm/parameter:Parameter", "db-password");
const HANDLER = urn("aws:lambda/function:Function", "handler");

const observedAt = "2026-10-25T12:00:00Z";
// The member graph of testdata/pulumi-member: node keys ignore stack and project, so its nodes are these resources' too.
const graph = { member: null, at: null, ids: [...readPulumiMember({ member: { dir: join(import.meta.dirname, "testdata", "pulumi-member"), label: "site" } }).entities.keys()] };

const { expectValid } = contract(schema);

function records() {
  return pulumiRefreshDriftRecords({
    member: "site",
    observedAt,
    graph,
    stack: "dev",
    reads: [
      { urn: ASSETS, refresh: read("bucket-edited.json") },
      { urn: ROLE, refresh: read("role-same.json") },
      { urn: GONE, refresh: read("policy-deleted.json") },
      { urn: DBPW, refresh: read("secret-edited.json") },
      { urn: HANDLER, refresh: read("refresh-op.json") },
    ],
  });
}
const at = (address: string) => records().find((r) => r.address === address)!;

describe("pulumi refresh --preview-only --json to drift records (#4453)", () => {
  test("the argv: one resource, preview only, JSON", () => {
    expect(pulumiRefreshArgs({ urn: ASSETS, stack: "dev" })).toEqual(["refresh", "--preview-only", "--json", "--stack", "dev", "--target", ASSETS]);
    expect(pulumiRefreshArgs()).toEqual(["refresh", "--preview-only", "--json"]);
  });

  test("an out-of-band edit yields a drifted record with the detailedDiff paths, state before, provider after", () => {
    const bucket = at(ASSETS);
    expect(bucket).toMatchObject({
      member: "site",
      engine: "pulumi",
      address: ASSETS,
      resourceType: "aws:s3/bucket:Bucket",
      node: "site/aws:s3/bucket:Bucket::assets",
      observedAt,
      read: "refresh",
      status: "drifted",
      evidence: { tool: "pulumi", command: `pulumi refresh --preview-only --json --stack dev --target ${ASSETS}`, engineCode: "update" },
    });
    expect(bucket.attributes).toEqual([
      { path: "acl", before: "private", after: "public-read" },
      { path: "tags.env", before: "dev", after: "prod-hotfix" },
    ]);
  });

  test("same is in-sync, delete is missing", () => {
    expect(at(ROLE)).toMatchObject({ status: "in-sync", node: "site/aws:iam/role:Role::web" });
    expect(at(ROLE).attributes).toBeUndefined();
    expect(at(GONE)).toMatchObject({ status: "missing", node: "site/aws:iam/rolePolicy:RolePolicy::webReadsAssets", evidence: { engineCode: "delete" } });
  });

  test("a secret-wrapped value is sensitive, with neither side", () => {
    expect(at(DBPW).status).toBe("drifted");
    expect(at(DBPW).attributes).toEqual([
      { path: "value", sensitive: true },
      { path: "version", before: 3, after: 4 },
    ]);
    expect(JSON.stringify(at(DBPW))).not.toContain("[secret]");
  });

  test("a refresh step with both states is compared on its outputs", () => {
    expect(at(HANDLER).status).toBe("drifted");
    expect(at(HANDLER).attributes).toEqual([{ path: "timeout", before: 3, after: 30 }]);
    // The graph holds the handler under its component, not at the top level: no node.
    expect(at(HANDLER).node).toBeNull();
  });

  test("a target the refresh printed nothing for is not-reached; a failed run carries its reason", () => {
    const [none, failed] = pulumiRefreshDriftRecords({
      member: "site",
      observedAt,
      reads: [
        { urn: ASSETS, refresh: read("role-same.json") },
        { urn: ROLE, failed: { reason: "no-credentials", detail: "error: no credentials" } },
      ],
    });
    expect(none).toMatchObject({ address: ASSETS, status: "not-observed", unobserved: { reason: "not-reached", queried: ASSETS } });
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
    const list = pulumiRefreshDocumentRecords({ member: "site", observedAt, refresh: read("bucket-edited.json") });
    expect(list.map((r) => [r.address, r.status])).toEqual([[ASSETS, "drifted"]]);
    expect(list[0].evidence.command).toBe("pulumi refresh --preview-only --json");
    expect(() => pulumiRefreshDocumentRecords({ member: "site", observedAt, refresh: {} })).toThrow(/no top-level "steps"/);
  });
});

describe("a member on plunge: plunge drift --resource <urn> --stream through chant's decoder (#4453)", () => {
  // Hand-written to the layout plunge P-L5 prints: drift-start, one drift-record, drift-settle with plunge's reads.
  const stream = (name: string) => readFileSync(join(import.meta.dirname, "testdata", "plunge-drift", name), "utf-8");

  test("the argv: one resource, streamed", () => {
    expect(plungeDriftArgs({ urn: ASSETS, stack: "dev", member: "site" })).toEqual(["drift", "--resource", ASSETS, "--stream", "--stack", "dev", "--member", "site"]);
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
      [ROLE, "plunge", "refresh", "in-sync", "site/aws:iam/role:Role::web"],
      [ASSETS, "plunge", "refresh", "drifted", "site/aws:s3/bucket:Bucket::assets"],
    ]);
    expect(list.find((r) => r.address === ASSETS)!.attributes).toEqual([
      { path: "acl", before: "private", after: "public-read" },
      { path: "tags.env", before: "dev", after: "prod-hotfix" },
    ]);
    expect(list.find((r) => r.address === ASSETS)!.evidence).toMatchObject({ tool: "plunge", engineCode: "update" });
    expectValid(driftDocument(list));
  });

  test("a stream that settles without the URN is not-reached; one that does not decode, or a failed run, is not-observed", () => {
    const [empty] = plungeDriftStreamRecords({ member: "site", observedAt, graph, reads: [{ urn: ROLE, stream: stream("settled-empty.ndjson") }] });
    expect(empty).toMatchObject({ address: ROLE, engine: "plunge", status: "not-observed", unobserved: { reason: "not-reached" }, node: "site/aws:iam/role:Role::web" });
    const [garbled, failed] = plungeDriftStreamRecords({
      member: "site",
      observedAt,
      reads: [
        { urn: ASSETS, stream: "not json\n" },
        { urn: ROLE, failed: { reason: "read-failed", detail: "plunge: no state backend" } },
      ],
    });
    expect(garbled).toMatchObject({ address: ASSETS, status: "not-observed", unobserved: { reason: "read-failed", detail: expect.stringMatching(/did not decode/) } });
    expect(failed).toMatchObject({ address: ROLE, status: "not-observed", unobserved: { reason: "read-failed", detail: "plunge: no state backend" } });
  });
});
