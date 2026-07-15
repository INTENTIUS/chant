import { describe, test, expect } from "vitest";
import { applyAwsEndpoint, applyAwsEndpointArgv } from "./cloud-executor";

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
