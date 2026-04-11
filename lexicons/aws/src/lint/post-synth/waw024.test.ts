import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw024, checkAlbAccessLogs } from "./waw024";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW024: ALB Without Access Logging", () => {
  test("check metadata", () => {
    expect(waw024.id).toBe("WAW024");
    expect(waw024.description).toContain("access logging");
  });

  test("flags ALB without access logging", () => {
    const ctx = makeCtx({
      Resources: {
        MyALB: {
          Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          Properties: { Type: "application" },
        },
      },
    });
    const diags = checkAlbAccessLogs(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW024");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when access logging is enabled", () => {
    const ctx = makeCtx({
      Resources: {
        MyALB: {
          Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          Properties: {
            LoadBalancerAttributes: [
              { Key: "access_logs.s3.enabled", Value: "true" },
              { Key: "access_logs.s3.bucket", Value: "my-logs-bucket" },
            ],
          },
        },
      },
    });
    const diags = checkAlbAccessLogs(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags when access_logs.s3.enabled is false", () => {
    const ctx = makeCtx({
      Resources: {
        MyALB: {
          Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          Properties: {
            LoadBalancerAttributes: [
              { Key: "access_logs.s3.enabled", Value: "false" },
            ],
          },
        },
      },
    });
    const diags = checkAlbAccessLogs(ctx);
    expect(diags).toHaveLength(1);
  });
});
