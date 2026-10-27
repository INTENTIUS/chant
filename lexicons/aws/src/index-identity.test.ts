/**
 * #4523 on the aws lexicon: never-deployed declarations matched to an
 * indexed fixture by the CloudFormation `primaryIdentifier`. The fixture is
 * the emulator check written out on INTENTIUS/behold#1025's design comment,
 * in miniature: a bucket and a role made outside chant, then a source that
 * declares them, a second bucket that does not exist, a queue and an
 * instance.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { matchDeclaredToIndex, type IndexIdentity } from "@intentius/chant/lifecycle/identity-match";
import { typeListing, type ListingLexicon, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { awsDeclaredIdentity, awsIndexIdentity, isGlobalAwsType, type IdentityManifestEntry } from "./index-identity";
import { awsKindForListedType } from "./listed-types";
import { awsPlugin } from "./plugin";

// The manifest rows these types generate (`lexicon-aws.json`): primaryIdentifier
// and the readOnlyProperties codegen writes as `attrs`, as surface.snapshot.json records them.
const ROWS: IdentityManifestEntry[] = [
  { resourceType: "AWS::S3::Bucket", kind: "resource", primaryIdentifier: ["BucketName"], attrs: { Arn: "Arn", DomainName: "DomainName", RegionalDomainName: "RegionalDomainName", WebsiteURL: "WebsiteURL" } },
  { resourceType: "AWS::IAM::Role", kind: "resource", primaryIdentifier: ["RoleName"], attrs: { Arn: "Arn", RoleId: "RoleId" } },
  { resourceType: "AWS::SQS::Queue", kind: "resource", primaryIdentifier: ["QueueUrl"], attrs: { Arn: "Arn", QueueUrl: "QueueUrl" } },
  { resourceType: "AWS::EC2::Instance", kind: "resource", primaryIdentifier: ["InstanceId"], attrs: { InstanceId: "InstanceId", PrivateIp: "PrivateIp", PublicIp: "PublicIp" } },
  { resourceType: "AWS::DynamoDB::Table", kind: "resource", primaryIdentifier: ["TableName"], attrs: { Arn: "Arn", StreamArn: "StreamArn" } },
  { resourceType: "AWS::EC2::Route", kind: "resource", primaryIdentifier: ["RouteTableId", "CidrBlock"], attrs: { CidrBlock: "CidrBlock" } },
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

const SOURCE = [
  { name: "assets", entityType: "AWS::S3::Bucket", props: { BucketName: "cli-made-assets" } },
  { name: "runner", entityType: "AWS::IAM::Role", props: { RoleName: "cli-made-role", AssumeRolePolicyDocument: {} } },
  { name: "archive", entityType: "AWS::S3::Bucket", props: { BucketName: "never-made-archive" } },
  { name: "jobs", entityType: "AWS::SQS::Queue", props: { QueueName: "cli-made-queue" } },
  { name: "box", entityType: "AWS::EC2::Instance", props: { InstanceType: "t3.micro", ImageId: "ami-0abcdef1234567890" } },
  { name: "carts", entityType: "AWS::DynamoDB::Table", props: { TableName: "carts" } },
];

describe("awsDeclaredIdentity", () => {
  test("a declared name is the identifier", () => {
    expect(awsDeclaredIdentity("AWS::S3::Bucket", { BucketName: "b1" }, MANIFEST)).toEqual({ kind: "identifier", listedType: "AWS::S3::Bucket", identifier: "b1", global: false });
    expect(awsDeclaredIdentity("AWS::IAM::Role", { RoleName: "r1" }, MANIFEST)).toMatchObject({ identifier: "r1", global: true });
  });

  test("a server-assigned identity is refused, naming the read-only part", () => {
    const queue = awsDeclaredIdentity("AWS::SQS::Queue", { QueueName: "q" }, MANIFEST);
    expect(queue).toMatchObject({ kind: "unmatchable", reason: "no-binding" });
    expect(queue.kind === "unmatchable" && queue.detail).toContain("QueueUrl");
    // Even a declaration that spells an instance id cannot be trusted to name the instance.
    expect(awsDeclaredIdentity("AWS::EC2::Instance", { InstanceId: "i-1" }, MANIFEST)).toMatchObject({ kind: "unmatchable", reason: "no-binding" });
  });

  test("a part the declaration leaves out, or spells with a Ref, is not in the declaration", () => {
    expect(awsDeclaredIdentity("AWS::S3::Bucket", {}, MANIFEST)).toMatchObject({ reason: "no-binding", detail: expect.stringContaining("identity is not in the declaration") });
    expect(awsDeclaredIdentity("AWS::S3::Bucket", { BucketName: { Ref: "Name" } }, MANIFEST)).toMatchObject({ reason: "no-binding" });
  });

  test("an identifier with a server-assigned part is refused even when the rest is declared", () => {
    expect(awsDeclaredIdentity("AWS::EC2::Route", { RouteTableId: "rtb-1", DestinationCidrBlock: "0.0.0.0/0" }, MANIFEST)).toMatchObject({ reason: "no-binding" });
  });

  test("a type with no primary identifier on record is unsupported", () => {
    expect(awsDeclaredIdentity("AWS::Made::Up", { Name: "x" }, MANIFEST)).toMatchObject({ kind: "unmatchable", reason: "unsupported-kind" });
  });

  test("global types are the ones behold's lister indexes at location global", () => {
    expect(isGlobalAwsType("AWS::IAM::Role")).toBe(true);
    expect(isGlobalAwsType("AWS::Route53::HostedZone")).toBe(true);
    expect(isGlobalAwsType("AWS::S3::Bucket")).toBe(false);
  });

  test("the plugin declares it", () => {
    expect(awsPlugin.indexIdentity?.substrate).toBe("aws");
  });
});

describe("matchDeclaredToIndex on the aws fixture", () => {
  const { matches } = matchDeclaredToIndex(SOURCE, [doc], identity, { region: "us-east-1" });

  test("a never-deployed declared bucket and role bind to their indexed resources", () => {
    expect(matches.assets).toMatchObject({ verdict: "bound", node: "aws/000000000000/us-east-1/AWS::S3::Bucket/cli-made-assets" });
    expect(matches.runner).toMatchObject({ verdict: "bound", node: "aws/000000000000/global/AWS::IAM::Role/cli-made-role" });
  });

  test("a bucket the index listed and did not find is absent", () => {
    expect(matches.archive).toMatchObject({ verdict: "absent", identifier: "never-made-archive", location: "us-east-1" });
  });

  test("a queue and an instance cannot match from source: no-binding, even though both are indexed", () => {
    expect(matches.jobs).toMatchObject({ verdict: "not-observed", reason: "no-binding" });
    expect(matches.box).toMatchObject({ verdict: "not-observed", reason: "no-binding" });
  });

  test("a type outside the index's --types is not observed (filtered), not absent", () => {
    expect(matches.carts).toMatchObject({ verdict: "not-observed", reason: "filtered", listedType: "AWS::DynamoDB::Table" });
  });

  test("the same source over an index without the bucket type reports the buckets filtered", () => {
    const narrowed: ListingResult = {
      ...listing,
      scope: { ...listing.scope, types: ["AWS::EC2::Instance", "AWS::IAM::Role", "AWS::SQS::Queue"] },
      resources: listing.resources.filter((r) => r.listedType !== "AWS::S3::Bucket"),
      coverage: listing.coverage.filter((c) => c.listedType !== "AWS::S3::Bucket"),
    };
    const { matches: m } = matchDeclaredToIndex(SOURCE, [typeListing(narrowed, [aws])], identity, { region: "us-east-1" });
    expect(m.assets).toMatchObject({ verdict: "not-observed", reason: "filtered" });
    expect(m.archive).toMatchObject({ verdict: "not-observed", reason: "filtered" });
    expect(m.runner).toMatchObject({ verdict: "bound" });
  });

  test("two indexed buckets with the bucket's name are refused by name", () => {
    const twice: ListingResult = {
      ...listing,
      scope: { ...listing.scope, locations: ["us-east-1", "us-west-2"] },
      resources: [...listing.resources, { ...listing.resources[0], location: "us-west-2" }],
      coverage: [...listing.coverage, { listedType: "AWS::S3::Bucket", location: "us-west-2", verdict: "listed" }],
    };
    const { matches: m } = matchDeclaredToIndex([SOURCE[0]], [typeListing(twice, [aws])], identity);
    expect(m.assets).toMatchObject({
      verdict: "refused",
      candidates: ["aws/000000000000/us-east-1/AWS::S3::Bucket/cli-made-assets", "aws/000000000000/us-west-2/AWS::S3::Bucket/cli-made-assets"],
    });
  });
});
