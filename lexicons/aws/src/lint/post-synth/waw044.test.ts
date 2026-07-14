import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw044, checkAlbHttpRedirect } from "./waw044";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW044: ALB HTTP Listener Not Redirecting To HTTPS", () => {
  test("check metadata", () => {
    expect(waw044.id).toBe("WAW044");
    expect(waw044.description).toContain("HTTPS");
  });

  test("flags an HTTP listener with no redirect action", () => {
    const ctx = makeCtx({
      Resources: {
        HttpListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {
            Protocol: "HTTP",
            Port: 80,
            DefaultActions: [{ Type: "forward", TargetGroupArn: "arn:aws:...:tg" }],
          },
        },
      },
    });
    const diags = checkAlbHttpRedirect(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW044");
    expect(diags[0].severity).toBe("error");
  });

  test("no diagnostic when the HTTP listener redirects to HTTPS", () => {
    const ctx = makeCtx({
      Resources: {
        HttpListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {
            Protocol: "HTTP",
            Port: 80,
            DefaultActions: [
              { Type: "redirect", RedirectConfig: { Protocol: "HTTPS", Port: "443", StatusCode: "HTTP_301" } },
            ],
          },
        },
      },
    });
    expect(checkAlbHttpRedirect(ctx)).toHaveLength(0);
  });

  test("no diagnostic for an HTTPS listener", () => {
    const ctx = makeCtx({
      Resources: {
        HttpsListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {
            Protocol: "HTTPS",
            Port: 443,
            DefaultActions: [{ Type: "forward", TargetGroupArn: "arn:aws:...:tg" }],
          },
        },
      },
    });
    expect(checkAlbHttpRedirect(ctx)).toHaveLength(0);
  });

  test("skips intrinsic Protocol values", () => {
    const ctx = makeCtx({
      Resources: {
        Listener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { Protocol: { Ref: "ProtocolParam" }, DefaultActions: [] },
        },
      },
    });
    expect(checkAlbHttpRedirect(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-Listener resources", () => {
    const ctx = makeCtx({
      Resources: { MyLb: { Type: "AWS::ElasticLoadBalancingV2::LoadBalancer", Properties: {} } },
    });
    expect(checkAlbHttpRedirect(ctx)).toHaveLength(0);
  });
});
