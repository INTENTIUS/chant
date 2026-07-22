import { describe, test, expect } from "vitest";
import { AWS_CARVE_TYPES, awsCarveType, applyAwsMapper } from "./aws-resources";
import { TIER_MAP } from "./tier-map";
import { canAdoptFromState } from "./adopt-state";

describe("AWS carve-out table", () => {
  test("advise and emit cover exactly the same AWS types (no cliff)", () => {
    // Every AWS type the advisor ranks (tier map) must be emittable, and vice
    // versa. Non-AWS entries (kubernetes_manifest) are excluded.
    const tierAws = Object.keys(TIER_MAP).filter((t) => t.startsWith("aws_")).sort();
    const emitAws = AWS_CARVE_TYPES.map((t) => t.tfType).sort();
    expect(tierAws).toEqual(emitAws);
    for (const t of emitAws) expect(canAdoptFromState(t)).toBe(true);
  });

  test("covers the common carve targets across families", () => {
    const types = new Set(AWS_CARVE_TYPES.map((t) => t.tfType));
    for (const t of [
      "aws_s3_bucket", "aws_iam_role", "aws_iam_policy", "aws_dynamodb_table",
      "aws_lambda_function", "aws_sns_topic", "aws_sqs_queue", "aws_kms_key",
      "aws_secretsmanager_secret", "aws_ssm_parameter", "aws_ecr_repository",
      "aws_vpc", "aws_subnet", "aws_security_group", "aws_route53_zone",
      "aws_cloudwatch_log_group",
    ]) {
      expect(types.has(t)).toBe(true);
    }
    expect(AWS_CARVE_TYPES.length).toBeGreaterThanOrEqual(20);
  });

  test("every constructor name is unique and non-empty", () => {
    const ctors = AWS_CARVE_TYPES.map((t) => t.ctor);
    expect(ctors.every((c) => c.length > 0)).toBe(true);
    expect(new Set(ctors).size).toBe(ctors.length);
  });
});

describe("applyAwsMapper", () => {
  test("renames fields to CloudFormation props and reshapes tags", () => {
    const { props, mappedKeys } = applyAwsMapper(awsCarveType("aws_s3_bucket")!, {
      id: "b", bucket: "my-bucket", tags: { Env: "prod" }, force_destroy: false,
    });
    expect(props).toEqual({ BucketName: "my-bucket", Tags: [{ Key: "Env", Value: "prod" }] });
    expect(mappedKeys).toContain("bucket");
    expect(mappedKeys).toContain("tags");
    expect(mappedKeys).not.toContain("force_destroy"); // stays unmapped
  });

  test("parses a JSON-string policy into an object", () => {
    const { props } = applyAwsMapper(awsCarveType("aws_iam_role")!, {
      name: "r",
      assume_role_policy: '{"Version":"2012-10-17","Statement":[]}',
      managed_policy_arns: ["arn:aws:iam::aws:policy/X"],
    });
    expect(props.RoleName).toBe("r");
    expect(props.AssumeRolePolicyDocument).toEqual({ Version: "2012-10-17", Statement: [] });
    expect(props.ManagedPolicyArns).toEqual(["arn:aws:iam::aws:policy/X"]);
  });

  test("wraps an instance-profile role into a list", () => {
    const { props } = applyAwsMapper(awsCarveType("aws_iam_instance_profile")!, { name: "p", role: "my-role" });
    expect(props).toEqual({ InstanceProfileName: "p", Roles: ["my-role"] });
  });

  test("a malformed JSON policy is preserved as a string, not dropped", () => {
    const { props } = applyAwsMapper(awsCarveType("aws_iam_policy")!, { name: "p", policy: "not json {" });
    expect(props.PolicyDocument).toBe("not json {");
  });

  test("omits absent attributes", () => {
    const { props } = applyAwsMapper(awsCarveType("aws_subnet")!, { vpc_id: "vpc-1", cidr_block: "10.0.1.0/24" });
    expect(props).toEqual({ VpcId: "vpc-1", CidrBlock: "10.0.1.0/24" });
    expect(props).not.toHaveProperty("AvailabilityZone");
  });
});
