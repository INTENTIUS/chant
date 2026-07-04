import { describe, test, expect } from "vitest";
import { applyAwsEndpoint } from "./cloud-executor";

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
