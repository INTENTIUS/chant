import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw023, checkCloudFrontWaf } from "./waw023";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW023: CloudFront Without WAF", () => {
  test("check metadata", () => {
    expect(waw023.id).toBe("WAW023");
    expect(waw023.description).toContain("WAF");
  });

  test("flags distribution without WebACLId", () => {
    const ctx = makeCtx({
      Resources: {
        MyCF: {
          Type: "AWS::CloudFront::Distribution",
          Properties: {
            DistributionConfig: {
              Origins: [{ Id: "origin1", DomainName: "example.com" }],
              DefaultCacheBehavior: { TargetOriginId: "origin1", ViewerProtocolPolicy: "redirect-to-https" },
              Enabled: true,
            },
          },
        },
      },
    });
    const diags = checkCloudFrontWaf(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW023");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when WebACLId is present", () => {
    const ctx = makeCtx({
      Resources: {
        MyCF: {
          Type: "AWS::CloudFront::Distribution",
          Properties: {
            DistributionConfig: {
              WebACLId: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-acl/abc",
              Enabled: true,
            },
          },
        },
      },
    });
    const diags = checkCloudFrontWaf(ctx);
    expect(diags).toHaveLength(0);
  });
});
