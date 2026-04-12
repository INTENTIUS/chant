import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw019, checkUnrestrictedIngress } from "./waw019";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW019: Security Group Unrestricted Ingress", () => {
  test("check metadata", () => {
    expect(waw019.id).toBe("WAW019");
    expect(waw019.description).toContain("ingress");
  });

  test("flags SG with 0.0.0.0/0 on port 22", () => {
    const ctx = makeCtx({
      Resources: {
        MySG: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [
              { IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "0.0.0.0/0" },
            ],
          },
        },
      },
    });
    const diags = checkUnrestrictedIngress(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW019");
    expect(diags[0].severity).toBe("error");
  });

  test("flags SG with ::/0 on port 3389", () => {
    const ctx = makeCtx({
      Resources: {
        MySG: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [
              { IpProtocol: "tcp", FromPort: 3389, ToPort: 3389, CidrIpv6: "::/0" },
            ],
          },
        },
      },
    });
    const diags = checkUnrestrictedIngress(ctx);
    expect(diags).toHaveLength(1);
  });

  test("flags wide port range containing sensitive port", () => {
    const ctx = makeCtx({
      Resources: {
        MySG: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [
              { IpProtocol: "tcp", FromPort: 0, ToPort: 65535, CidrIp: "0.0.0.0/0" },
            ],
          },
        },
      },
    });
    const diags = checkUnrestrictedIngress(ctx);
    expect(diags).toHaveLength(1);
  });

  test("no diagnostic for restricted CIDR", () => {
    const ctx = makeCtx({
      Resources: {
        MySG: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [
              { IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "10.0.0.0/8" },
            ],
          },
        },
      },
    });
    const diags = checkUnrestrictedIngress(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for non-sensitive port with open CIDR", () => {
    const ctx = makeCtx({
      Resources: {
        MySG: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [
              { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
            ],
          },
        },
      },
    });
    const diags = checkUnrestrictedIngress(ctx);
    expect(diags).toHaveLength(0);
  });

  test("checks standalone SecurityGroupIngress resources", () => {
    const ctx = makeCtx({
      Resources: {
        MyIngress: {
          Type: "AWS::EC2::SecurityGroupIngress",
          Properties: {
            GroupId: { Ref: "MySG" },
            IpProtocol: "tcp",
            FromPort: 5432,
            ToPort: 5432,
            CidrIp: "0.0.0.0/0",
          },
        },
      },
    });
    const diags = checkUnrestrictedIngress(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("MyIngress");
  });

  test("handles missing port range (all ports)", () => {
    const ctx = makeCtx({
      Resources: {
        MySG: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [
              { IpProtocol: "-1", CidrIp: "0.0.0.0/0" },
            ],
          },
        },
      },
    });
    const diags = checkUnrestrictedIngress(ctx);
    expect(diags).toHaveLength(1);
  });
});
