import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw045, checkAlbTlsPolicy } from "./waw045";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW045: ALB Weak Or Missing TLS Policy", () => {
  test("check metadata", () => {
    expect(waw045.id).toBe("WAW045");
    expect(waw045.description).toContain("TLS");
  });

  test("flags an HTTPS listener with no SslPolicy", () => {
    const ctx = makeCtx({
      Resources: {
        HttpsListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { Protocol: "HTTPS", Port: 443 },
        },
      },
    });
    const diags = checkAlbTlsPolicy(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW045");
    expect(diags[0].severity).toBe("error");
  });

  test("flags a legacy SslPolicy (TLS 1.0 default)", () => {
    const ctx = makeCtx({
      Resources: {
        HttpsListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { Protocol: "HTTPS", SslPolicy: "ELBSecurityPolicy-2016-08" },
        },
      },
    });
    expect(checkAlbTlsPolicy(ctx)).toHaveLength(1);
  });

  test("flags an explicit TLS 1.1 policy", () => {
    const ctx = makeCtx({
      Resources: {
        HttpsListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { Protocol: "HTTPS", SslPolicy: "ELBSecurityPolicy-TLS-1-1-2017-01" },
        },
      },
    });
    expect(checkAlbTlsPolicy(ctx)).toHaveLength(1);
  });

  test("no diagnostic for a modern TLS 1.2 policy", () => {
    const ctx = makeCtx({
      Resources: {
        HttpsListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { Protocol: "HTTPS", SslPolicy: "ELBSecurityPolicy-TLS-1-2-2017-01" },
        },
      },
    });
    expect(checkAlbTlsPolicy(ctx)).toHaveLength(0);
  });

  test("no diagnostic for a modern TLS13 policy on a TLS (NLB) listener", () => {
    const ctx = makeCtx({
      Resources: {
        TlsListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { Protocol: "TLS", SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06" },
        },
      },
    });
    expect(checkAlbTlsPolicy(ctx)).toHaveLength(0);
  });

  test("no diagnostic for a plain HTTP listener (not in scope)", () => {
    const ctx = makeCtx({
      Resources: {
        HttpListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { Protocol: "HTTP" },
        },
      },
    });
    expect(checkAlbTlsPolicy(ctx)).toHaveLength(0);
  });

  test("skips intrinsic SslPolicy values", () => {
    const ctx = makeCtx({
      Resources: {
        HttpsListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { Protocol: "HTTPS", SslPolicy: { Ref: "PolicyParam" } },
        },
      },
    });
    expect(checkAlbTlsPolicy(ctx)).toHaveLength(0);
  });
});
