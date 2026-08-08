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
