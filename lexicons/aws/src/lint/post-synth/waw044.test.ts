import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw044, checkAlbHttpRedirect } from "./waw044";

function makeCtx(template: object, env?: string) {
  return { ...createPostSynthContext({ aws: template }), env };
}

describe("WAW044: ALB HTTP Listener Not Redirecting To HTTPS (full tier)", () => {
  test("check metadata", () => {
    expect(waw044.id).toBe("WAW044");
    expect(waw044.description).toContain("HTTPS");
  });

  const template = {
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
  };

  test("warns (not errors) on the light tier — no env set", () => {
    const diags = checkAlbHttpRedirect(makeCtx(template));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW044");
    expect(diags[0].severity).toBe("warning");
  });

  test("warns on a non-production env", () => {
    const diags = checkAlbHttpRedirect(makeCtx(template, "dev"));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
  });

  test("errors on the full/production tier", () => {
    const diags = checkAlbHttpRedirect(makeCtx(template, "prod"));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
  });

  test("errors on env: production", () => {
    const diags = checkAlbHttpRedirect(makeCtx(template, "production"));
    expect(diags[0].severity).toBe("error");
  });

  test("errors on env: full", () => {
    const diags = checkAlbHttpRedirect(makeCtx(template, "full"));
    expect(diags[0].severity).toBe("error");
  });

  test("no diagnostic when the HTTP listener redirects to HTTPS, even in prod", () => {
    const ctx = makeCtx(
      {
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
      },
      "prod",
    );
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
