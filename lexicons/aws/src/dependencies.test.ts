import { describe, it, expect } from "vitest";
import { toIngressRules } from "./dependencies";

// #1276 — the two AWS surfaces disagree about the same concept. A template's
// SecurityGroupIngress carries CidrIp flat; describe-security-groups nests
// sources under IpRanges[]/Ipv6Ranges[]/UserIdGroupPairs[], and one permission
// can hold several. Handing the describe shape to the fold unchanged renders
// every source as `?`, which matches no CIDR query and narrows the answer.
describe("toIngressRules (#1276)", () => {
  it("flattens an IPv4 range into the flat rule the fold reads", () => {
    expect(
      toIngressRules([{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }]),
    ).toEqual([{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "0.0.0.0/0" }]);
  });

  it("emits one rule per source, because that is what the flat shape means", () => {
    const rules = toIngressRules([
      {
        IpProtocol: "tcp",
        FromPort: 443,
        ToPort: 443,
        IpRanges: [{ CidrIp: "10.0.0.0/8" }, { CidrIp: "192.168.0.0/16" }],
        UserIdGroupPairs: [{ GroupId: "sg-peer" }],
      },
    ]);
    expect(rules).toHaveLength(3);
    expect(rules.map((r) => r.CidrIp ?? r.SourceSecurityGroupId)).toEqual([
      "10.0.0.0/8",
      "192.168.0.0/16",
      "sg-peer",
    ]);
  });

  it("carries IPv6 sources through their own key", () => {
    expect(toIngressRules([{ IpProtocol: "tcp", Ipv6Ranges: [{ CidrIpv6: "::/0" }] }])).toEqual([
      { IpProtocol: "tcp", CidrIpv6: "::/0" },
    ]);
  });

  it("an all-protocols rule keeps the -1 the fold expects, and omits absent ports", () => {
    // FromPort absent is "all ports" to normalizeIngress; emitting FromPort:
    // undefined would render as a port range rather than `all`.
    expect(toIngressRules([{ IpRanges: [{ CidrIp: "0.0.0.0/0" }] }])).toEqual([
      { IpProtocol: "-1", CidrIp: "0.0.0.0/0" },
    ]);
  });

  it("a permission with no source contributes nothing", () => {
    expect(toIngressRules([{ IpProtocol: "tcp", FromPort: 22, ToPort: 22 }])).toEqual([]);
  });
});
