import { describe, it, expect } from "vitest";
import { resolveKindTerms } from "./search";
import type { IRNode } from "../../graph-ir";

const nodes = [
  { id: "vpc", kind: "AWS::EC2::VPC", lexicon: "aws", attrs: {} },
  { id: "att", kind: "AWS::EC2::VPCGatewayAttachment", lexicon: "aws", attrs: {} },
  { id: "sub", kind: "AWS::EC2::Subnet", lexicon: "aws", attrs: {} },
  { id: "assoc", kind: "AWS::EC2::SubnetRouteTableAssociation", lexicon: "aws", attrs: {} },
  { id: "igw", kind: "AWS::EC2::InternetGateway", lexicon: "aws", attrs: {} },
] as IRNode[];

const resolve = (a: string) => {
  const t = { kind: "kind" as const, a };
  resolveKindTerms([t], nodes);
  return t.kinds ? [...t.kinds].sort() : undefined;
};

describe("a kind term means the kind, not any type containing its letters", () => {
  it("EC2::VPC is the VPC, not the gateway attachment", () => {
    // The estate has 6 VPCs and answered 9. VPCGatewayAttachment contains the
    // characters "EC2::VPC" and is not a VPC.
    expect(resolve("EC2::VPC")).toEqual(["AWS::EC2::VPC"]);
  });

  it("Subnet is the subnet, not the route table association", () => {
    expect(resolve("Subnet")).toEqual(["AWS::EC2::Subnet"]);
  });

  it("a full type still resolves to itself", () => {
    expect(resolve("AWS::EC2::Subnet")).toEqual(["AWS::EC2::Subnet"]);
  });

  it("a genuine substring search still works", () => {
    // Nothing lines up with a `::` boundary here, so the documented substring
    // rule applies and finds both gateway-ish kinds.
    expect(resolve("Gateway")).toBeUndefined();
  });

  it("resolves inside an edge sub-term, where the negation lives", () => {
    const t = { kind: "edge" as const, a: "", dir: "in" as const, sub: { kind: "kind" as const, a: "EC2::VPC" } };
    resolveKindTerms([t], nodes);
    expect(t.sub.kinds && [...t.sub.kinds]).toEqual(["AWS::EC2::VPC"]);
  });
});
