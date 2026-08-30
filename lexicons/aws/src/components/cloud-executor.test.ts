import { describe, test, expect } from "vitest";
import {
  applyAwsEndpoint,
  applyAwsEndpointArgv,
  awsDeployCapabilities,
  awsDeployCapabilitiesForBody,
  awsDeployCapabilityList,
  ecsDeploymentId,
  ecsServiceStable,
} from "./cloud-executor";

describe("ecsDeploymentId / ecsServiceStable — tolerate Floci's missing deployments (#937)", () => {
  test("deployment id: real AWS shape", () => {
    expect(ecsDeploymentId({ service: { deployments: [{ id: "ecs-svc/123" }] } })).toBe("ecs-svc/123");
  });
  test("deployment id: Floci omits `deployments` entirely → '' (no crash)", () => {
    expect(ecsDeploymentId({ service: {} })).toBe("");
    expect(ecsDeploymentId({ service: { deployments: [] } })).toBe("");
  });

  test("stable: running==desired with ≤1 deployment", () => {
    expect(ecsServiceStable({ runningCount: 2, desiredCount: 2, deployments: [{}] })).toBe(true);
    expect(ecsServiceStable({ runningCount: 1, desiredCount: 2, deployments: [{}] })).toBe(false);
    expect(ecsServiceStable({ runningCount: 2, desiredCount: 2, deployments: [{}, {}] })).toBe(false);
  });
  test("stable: Floci omits `deployments` → treated as 0, no crash", () => {
    expect(ecsServiceStable({ runningCount: 2, desiredCount: 2 })).toBe(true);
    expect(ecsServiceStable(undefined)).toBe(true); // 0 == 0
  });
});

describe("applyAwsEndpoint", () => {
  const url = "http://localhost:4566";

  test("injects --endpoint-url into an aws command when set", () => {
    expect(applyAwsEndpoint("aws cloudformation describe-stacks --stack-name x", url)).toBe(
      "aws --endpoint-url 'http://localhost:4566' cloudformation describe-stacks --stack-name x",
    );
  });

  test("passes the command through unchanged when no endpoint is set", () => {
    expect(applyAwsEndpoint("aws s3 ls", undefined)).toBe("aws s3 ls");
    expect(applyAwsEndpoint("aws s3 ls", "")).toBe("aws s3 ls");
  });

  test("leaves non-aws commands (docker, piped aws) untouched at the front", () => {
    expect(applyAwsEndpoint("docker build -t x .", url)).toBe("docker build -t x .");
    // only the leading `aws` is rewritten; a piped aws inside is left as-is
    expect(applyAwsEndpoint("aws ecr get-login-password | docker login", url)).toBe(
      "aws --endpoint-url 'http://localhost:4566' ecr get-login-password | docker login",
    );
  });
});

describe("applyAwsEndpointArgv (#926)", () => {
  const url = "http://localhost:4566";

  test("inserts --endpoint-url after `aws` in an argv when set", () => {
    expect(
      applyAwsEndpointArgv(["aws", "cloudformation", "describe-stack-resources", "--stack-name", "prod"], url),
    ).toEqual(["aws", "--endpoint-url", url, "cloudformation", "describe-stack-resources", "--stack-name", "prod"]);
  });

  test("passes the argv through unchanged when no endpoint is set", () => {
    expect(applyAwsEndpointArgv(["aws", "s3", "ls"], undefined)).toEqual(["aws", "s3", "ls"]);
    expect(applyAwsEndpointArgv(["aws", "s3", "ls"], "")).toEqual(["aws", "s3", "ls"]);
  });

  test("leaves a non-aws argv untouched", () => {
    expect(applyAwsEndpointArgv(["docker", "ps"], url)).toEqual(["docker", "ps"]);
  });
});

describe("awsDeployCapabilities — CAPABILITY_AUTO_EXPAND for Transform macros", () => {
  test("plain template → CAPABILITY_NAMED_IAM only", () => {
    expect(awsDeployCapabilities({})).toBe("CAPABILITY_NAMED_IAM");
    expect(awsDeployCapabilities({ Transform: undefined })).toBe("CAPABILITY_NAMED_IAM");
  });
  test("a top-level Transform → adds CAPABILITY_AUTO_EXPAND", () => {
    expect(awsDeployCapabilities({ Transform: "AWS::SecretsManager-2020-07-23" })).toBe(
      "CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND",
    );
    expect(awsDeployCapabilities({ Transform: ["AWS::LanguageExtensions"] })).toContain("CAPABILITY_AUTO_EXPAND");
  });
  test("list form mirrors the string form", () => {
    expect(awsDeployCapabilityList({})).toEqual(["CAPABILITY_NAMED_IAM"]);
    expect(awsDeployCapabilityList({ Transform: "AWS::Serverless-2016-10-31" })).toEqual([
      "CAPABILITY_NAMED_IAM",
      "CAPABILITY_AUTO_EXPAND",
    ]);
    expect(awsDeployCapabilityList({ Transform: ["AWS::LanguageExtensions", "AWS::Serverless-2016-10-31"] })).toEqual([
      "CAPABILITY_NAMED_IAM",
      "CAPABILITY_AUTO_EXPAND",
    ]);
  });
  test("raw body: parses JSON, falls back to NAMED_IAM for non-JSON or empty input", () => {
    expect(awsDeployCapabilitiesForBody(JSON.stringify({ Transform: "AWS::SecretsManager-2020-07-23", Resources: {} }))).toEqual([
      "CAPABILITY_NAMED_IAM",
      "CAPABILITY_AUTO_EXPAND",
    ]);
    expect(awsDeployCapabilitiesForBody(JSON.stringify({ Resources: {} }))).toEqual(["CAPABILITY_NAMED_IAM"]);
    expect(awsDeployCapabilitiesForBody("Resources:\n  B:\n    Type: AWS::S3::Bucket\n")).toEqual(["CAPABILITY_NAMED_IAM"]);
    expect(awsDeployCapabilitiesForBody("")).toEqual(["CAPABILITY_NAMED_IAM"]);
  });
});
