import { describe, test, expect } from "vitest";
import { adoptFromState, canAdoptFromState, supportedStateAdoptionTypes, type DeferredParam } from "./adopt-state";
import type { StateResource } from "./state";

describe("adoptFromState", () => {
  test("maps a real S3 bucket state resource to native chant source", () => {
    const resource: StateResource = {
      type: "aws_s3_bucket",
      name: "assets",
      attributes: {
        id: "myapp-assets-prod",
        bucket: "myapp-assets-prod",
        arn: "arn:aws:s3:::myapp-assets-prod",
        tags: { Team: "web", Env: "prod" },
        force_destroy: false,
      },
    };
    const out = adoptFromState(resource)!;
    expect(out.fileName).toBe("assets.ts");
    expect(out.mapped).toBe(true);
    expect(out.nativeType).toBe("AWS::S3::Bucket");

    // Correct constructor + CloudFormation PascalCase props from real TF attrs.
    expect(out.content).toContain('import { Bucket } from "@intentius/chant-lexicon-aws";');
    expect(out.content).toContain("export const assets = new Bucket({");
    expect(out.content).toContain('BucketName: "myapp-assets-prod"');
    expect(out.content).toContain('{"Key":"Team","Value":"web"}');
    expect(out.content).toContain('{"Key":"Env","Value":"prod"}');

    // Unmapped attributes are preserved for reconciliation, not dropped.
    expect(out.content).toContain("Unmapped Terraform attributes");
    expect(out.content).toContain("force_destroy");
    // Mapped keys are not repeated in the unmapped block.
    expect(out.content).not.toContain('"bucket":');
  });

  test("maps a log group with retention", () => {
    const out = adoptFromState({
      type: "aws_cloudwatch_log_group",
      name: "api",
      attributes: { id: "/myapp/api", name: "/myapp/api", retention_in_days: 30, arn: "arn:...:log-group:/myapp/api" },
    })!;
    expect(out.content).toContain("new LogGroup({");
    expect(out.content).toContain('LogGroupName: "/myapp/api"');
    expect(out.content).toContain("RetentionInDays: 30");
  });

  test("a deferred input renders as a params reference, not the state literal (#998)", () => {
    const subnet: StateResource = {
      type: "aws_subnet",
      name: "a",
      attributes: { id: "subnet-0aa", vpc_id: "vpc-0abc", cidr_block: "10.0.1.0/24" },
    };
    const params: DeferredParam[] = [
      { name: "vpc_id", tfAttr: "vpc_id", survivor: "aws_vpc.main", attrs: ["id"], default: "vpc-0abc" },
    ];
    const out = adoptFromState(subnet, params)!;
    expect(out.parameterized).toEqual(["vpc_id"]);
    expect(out.content).toContain('import { params } from "@intentius/chant/params";');
    expect(out.content).toContain("VpcId: params.vpc_id as string,");
    expect(out.content).not.toContain('VpcId: "vpc-0abc"');
    // Non-deferred props keep their state literals.
    expect(out.content).toContain('CidrBlock: "10.0.1.0/24"');
  });

  test("a deferred input on an unmapped attribute leaves the source alone", () => {
    const lambda: StateResource = {
      type: "aws_lambda_function",
      name: "api",
      attributes: { id: "myapp-api", function_name: "myapp-api", environment: [{ variables: { B: "b" } }] },
    };
    const params: DeferredParam[] = [
      { name: "environment", tfAttr: "environment", survivor: "aws_s3_bucket.assets", attrs: ["bucket"] },
    ];
    const out = adoptFromState(lambda, params)!;
    expect(out.parameterized).toEqual([]);
    expect(out.content).not.toContain("@intentius/chant/params");
    expect(out.content).toContain('FunctionName: "myapp-api"');
  });

  test("folded sub-resources join the parent's emitted properties (#1637)", () => {
    const bucket: StateResource = {
      type: "aws_s3_bucket",
      name: "assets",
      attributes: {
        id: "myapp-assets-prod",
        bucket: "myapp-assets-prod",
        versioning: [{ enabled: true, mfa_delete: false }],
        server_side_encryption_configuration: [
          { rule: [{ apply_server_side_encryption_by_default: [{ sse_algorithm: "AES256" }], bucket_key_enabled: false }] },
        ],
      },
    };
    const out = adoptFromState(bucket, [], [
      {
        type: "aws_s3_bucket_versioning",
        name: "assets",
        attributes: { bucket: "myapp-assets-prod", versioning_configuration: [{ status: "Enabled" }], mfa: null },
      },
      {
        type: "aws_s3_bucket_public_access_block",
        name: "assets",
        attributes: {
          bucket: "myapp-assets-prod",
          block_public_acls: true,
          block_public_policy: true,
          ignore_public_acls: true,
          restrict_public_buckets: true,
        },
      },
    ])!;

    expect(out.content).toContain('VersioningConfiguration: {"Status":"Enabled"}');
    expect(out.content).toContain(
      'PublicAccessBlockConfiguration: {"BlockPublicAcls":true,"BlockPublicPolicy":true,"IgnorePublicAcls":true,"RestrictPublicBuckets":true}',
    );
    // The bucket's own in-state SSE block lands as BucketEncryption.
    expect(out.content).toContain('BucketEncryption: {"ServerSideEncryptionConfiguration"');
    // The source says what each fold contributed.
    expect(out.content).toContain("// Folded in aws_s3_bucket_versioning.assets -> VersioningConfiguration");
    expect(out.content).toContain(
      "// Folded in aws_s3_bucket_public_access_block.assets -> PublicAccessBlockConfiguration",
    );
    expect(out.folded).toEqual([
      { address: "aws_s3_bucket_versioning.assets", props: ["VersioningConfiguration"] },
      { address: "aws_s3_bucket_public_access_block.assets", props: ["PublicAccessBlockConfiguration"] },
    ]);
    // Only the genuinely unmappable leftover is in the comment.
    expect(out.content).toContain('"aws_s3_bucket_versioning.assets"');
    expect(out.content).toContain('"mfa": null');
  });

  test("a folded sub-resource with no mapping yet is reported, not dropped", () => {
    const out = adoptFromState(
      { type: "aws_s3_bucket", name: "assets", attributes: { bucket: "b" } },
      [],
      [{ type: "aws_s3_bucket_policy", name: "assets", attributes: { bucket: "b", policy: '{"Statement":[]}' } }],
    )!;
    expect(out.folded).toEqual([{ address: "aws_s3_bucket_policy.assets", props: [] }]);
    expect(out.content).toContain("// Folded in aws_s3_bucket_policy.assets -> nothing mappable");
    expect(out.content).toContain('"aws_s3_bucket_policy.assets"');
    expect(out.content).toContain('"policy"');
  });

  test("canAdoptFromState gates on a known native constructor", () => {
    expect(canAdoptFromState("aws_s3_bucket")).toBe(true);
    expect(canAdoptFromState("random_pet")).toBe(false);
  });

  test("supportedStateAdoptionTypes lists the mappable types, sorted", () => {
    const types = supportedStateAdoptionTypes();
    expect(types).toContain("aws_s3_bucket");
    expect(types).toContain("aws_sqs_queue");
    expect(types).toEqual([...types].sort());
    expect(types).not.toContain("aws_glue_job"); // not yet mapped
  });

  test("returns null for a type with no native constructor", () => {
    expect(adoptFromState({ type: "random_pet", name: "x", attributes: { id: "abc" } })).toBeNull();
  });
});
