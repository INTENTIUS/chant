import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw049, checkBroadIngress } from "./waw049";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW049: Security Group Broad Ingress (any port, except ALB:80/443)", () => {
  test("check metadata", () => {
    expect(waw049.id).toBe("WAW049");
    expect(waw049.description).toContain("443");
  });

  test("flags 0.0.0.0/0 ingress on an arbitrary app port (8080)", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [{ CidrIp: "0.0.0.0/0", IpProtocol: "tcp", FromPort: 8080, ToPort: 8080 }],
          },
        },
      },
    });
    const diags = checkBroadIngress(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW049");
    expect(diags[0].severity).toBe("error");
  });

  test("allows 0.0.0.0/0 ingress on exactly port 443 (ALB exception)", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [{ CidrIp: "0.0.0.0/0", IpProtocol: "tcp", FromPort: 443, ToPort: 443 }],
          },
        },
      },
    });
    expect(checkBroadIngress(ctx)).toHaveLength(0);
  });

  test("allows 0.0.0.0/0 ingress on exactly port 80 (light-tier public HTTP ALB, #917)", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [{ CidrIp: "0.0.0.0/0", IpProtocol: "tcp", FromPort: 80, ToPort: 80 }],
          },
        },
      },
    });
    expect(checkBroadIngress(ctx)).toHaveLength(0);
  });

  test("still flags 0.0.0.0/0 on SSH (22) — generalizes beyond WAW019's named ports too", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [{ CidrIp: "0.0.0.0/0", IpProtocol: "tcp", FromPort: 22, ToPort: 22 }],
          },
        },
      },
    });
    expect(checkBroadIngress(ctx)).toHaveLength(1);
  });

  test("flags a port range that includes but isn't exactly 443", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [{ CidrIp: "0.0.0.0/0", IpProtocol: "tcp", FromPort: 0, ToPort: 65535 }],
          },
        },
      },
    });
    expect(checkBroadIngress(ctx)).toHaveLength(1);
  });

  test("flags a rule with no port range (all ports) as unrestricted", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: { SecurityGroupIngress: [{ CidrIp: "0.0.0.0/0", IpProtocol: "-1" }] },
        },
      },
    });
    expect(checkBroadIngress(ctx)).toHaveLength(1);
  });

  test("no diagnostic for a restricted CIDR", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [{ CidrIp: "10.0.0.0/16", IpProtocol: "tcp", FromPort: 8080, ToPort: 8080 }],
          },
        },
      },
    });
    expect(checkBroadIngress(ctx)).toHaveLength(0);
  });

  test("checks standalone SecurityGroupIngress resources too", () => {
    const ctx = makeCtx({
      Resources: {
        MyIngress: {
          Type: "AWS::EC2::SecurityGroupIngress",
          Properties: { GroupId: "sg-123", CidrIp: "0.0.0.0/0", FromPort: 3000, ToPort: 3000 },
        },
      },
    });
    expect(checkBroadIngress(ctx)).toHaveLength(1);
  });

  test("skips intrinsic port values (can't verify it's the 443 exception)", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            SecurityGroupIngress: [{ CidrIp: "0.0.0.0/0", FromPort: { Ref: "PortParam" }, ToPort: { Ref: "PortParam" } }],
          },
        },
      },
    });
    expect(checkBroadIngress(ctx)).toHaveLength(0);
  });
});
