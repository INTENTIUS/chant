/**
 * #4525 on the aws lexicon: `chant search --index`'s join over the identity
 * fixture (#4523's, ./testdata/indexed/identity.listing.json). A declared
 * source with a bucket and a role made outside chant, a bucket that does not
 * exist, a queue, an instance and a table outside the index's --types, joined
 * through the aws lexicon's own index match. Each row gets one verdict, and
 * the overlay carries what the index read onto the bound rows only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { GraphIR, IRNode } from "@intentius/chant/graph-ir";
import type { IndexIdentity } from "@intentius/chant/lifecycle/identity-match";
import { joinDeclaredToIndex } from "@intentius/chant/lifecycle/index-join";
import { typeListing, type ListingLexicon, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { awsDeclaredIdentity, awsIndexIdentity, type IdentityManifestEntry } from "./index-identity";
import { awsKindForListedType } from "./listed-types";
import { awsPlugin } from "./plugin";

// The manifest rows these types generate, as index-identity.test.ts reads them.
const ROWS: IdentityManifestEntry[] = [
  { resourceType: "AWS::S3::Bucket", kind: "resource", primaryIdentifier: ["BucketName"], attrs: { Arn: "Arn", DomainName: "DomainName", RegionalDomainName: "RegionalDomainName", WebsiteURL: "WebsiteURL" } },
  { resourceType: "AWS::IAM::Role", kind: "resource", primaryIdentifier: ["RoleName"], attrs: { Arn: "Arn", RoleId: "RoleId" } },
  { resourceType: "AWS::SQS::Queue", kind: "resource", primaryIdentifier: ["QueueUrl"], attrs: { Arn: "Arn", QueueUrl: "QueueUrl" } },
  { resourceType: "AWS::EC2::Instance", kind: "resource", primaryIdentifier: ["InstanceId"], attrs: { InstanceId: "InstanceId", PrivateIp: "PrivateIp", PublicIp: "PublicIp" } },
  { resourceType: "AWS::DynamoDB::Table", kind: "resource", primaryIdentifier: ["TableName"], attrs: { Arn: "Arn", StreamArn: "StreamArn" } },
];
const MANIFEST: ReadonlyMap<string, IdentityManifestEntry> = new Map(ROWS.map((e) => [e.resourceType, e]));
const identity: IndexIdentity = { ...awsIndexIdentity, declaredIdentity: (t, p) => awsDeclaredIdentity(t, p, MANIFEST) };
const KINDS: ReadonlySet<string> = new Set(MANIFEST.keys());
const aws: ListingLexicon = {
  name: awsPlugin.name,
  deepNormalizationHooks: awsPlugin.deepNormalizationHooks,
  listedTypes: { ...awsPlugin.listedTypes!, kindFor: (t) => awsKindForListedType(t, KINDS) },
};
const listing = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "indexed", "identity.listing.json"), "utf-8")) as ListingResult;
const doc = typeListing(listing, [aws]);

const node = (name: string, kind: string, attrs: Record<string, unknown>): IRNode => ({ id: `app::${name}`, kind, lexicon: "aws", attrs });
const declared: GraphIR = {
  version: 1,
  nodes: [
    node("assets", "AWS::S3::Bucket", { BucketName: "cli-made-assets" }),
    node("runner", "AWS::IAM::Role", { RoleName: "cli-made-role", AssumeRolePolicyDocument: {} }),
    node("archive", "AWS::S3::Bucket", { BucketName: "never-made-archive" }),
    node("jobs", "AWS::SQS::Queue", { QueueName: "cli-made-queue" }),
    node("box", "AWS::EC2::Instance", { InstanceType: "t3.micro", ImageId: "ami-0abcdef1234567890" }),
    node("carts", "AWS::DynamoDB::Table", { TableName: "carts" }),
  ],
  edges: [],
  groups: { byLexicon: {} },
};

describe("search --index's join on the aws fixture", () => {
  const { ir, joins } = joinDeclaredToIndex(declared, doc, [{ name: "aws", indexIdentity: identity }], { regionOf: () => "us-east-1" });
  const row = (name: string) => ir.nodes.find((n) => n.id === `app::${name}`)!;

  test("the bucket and role made outside chant are bound, with what the index read about them", () => {
    expect(joins["app::assets"]).toMatchObject({ verdict: "bound", node: "aws/000000000000/us-east-1/AWS::S3::Bucket/cli-made-assets", nativeId: "cli-made-assets" });
    expect(joins["app::runner"]).toMatchObject({ verdict: "bound", node: "aws/000000000000/global/AWS::IAM::Role/cli-made-role", location: "global" });
    expect(row("assets").physicalId).toBe("cli-made-assets");
    // The aws hooks prune read-only properties such as Arn from the indexed tree
    // (#4521: an indexed tree has the shape an observed one has); the index
    // carries the ARN as a cloud id in the node's facts.
    expect(row("assets").attrs?.BucketName).toBe("cli-made-assets");
    expect(row("assets").facts?.cloudIds).toContainEqual({ kind: "arn", value: "arn:aws:s3:::cli-made-assets" });
  });

  test("the bucket the index listed and did not find is absent", () => {
    expect(joins["app::archive"]).toMatchObject({ verdict: "absent", identifier: "never-made-archive", location: "us-east-1" });
    expect(row("archive").physicalId).toBeUndefined();
  });

  test("the queue and the instance spell no identity: no-binding, though both are indexed", () => {
    expect(joins["app::jobs"]).toMatchObject({ verdict: "no-binding", detail: expect.stringContaining("QueueUrl") });
    expect(joins["app::box"]).toMatchObject({ verdict: "no-binding", detail: expect.stringContaining("InstanceId") });
    expect(row("jobs").physicalId).toBeUndefined();
  });

  test("the table outside --types is not observed, filtered", () => {
    expect(joins["app::carts"]).toMatchObject({ verdict: "not-observed", reason: "filtered", listedType: "AWS::DynamoDB::Table" });
  });

  test("only the declared rows are in the answer", () => {
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(declared.nodes.map((n) => n.id).sort());
  });
});
