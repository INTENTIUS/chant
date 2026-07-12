import { describe, it, expect } from "vitest";
import { resolveTemplateAttrs } from "./live-attrs";
import { reconstructEdges } from "@intentius/chant/graph-refs";
import type { IRNode } from "@intentius/chant/graph-ir";
import { awsReferenceCatalog } from "./reference-catalog";
import type { ExportedTemplate } from "@intentius/chant/lexicon";

const tmpl = (resources: Array<{ logicalId: string; type: string; properties: Record<string, unknown> }>): ExportedTemplate =>
  ({ resources, parameters: [], outputs: {} }) as unknown as ExportedTemplate;

describe("resolveTemplateAttrs", () => {
  it("resolves {Ref} and {Fn::GetAtt} intrinsics to bare logical ids", () => {
    const attrs = resolveTemplateAttrs(
      tmpl([
        { logicalId: "Subnet", type: "AWS::EC2::Subnet", properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.0.1.0/24" } },
        { logicalId: "Listener", type: "AWS::ElasticLoadBalancingV2::Listener", properties: { LoadBalancerArn: { "Fn::GetAtt": ["Alb", "Arn"] } } },
      ]),
    );
    expect(attrs.Subnet).toEqual({ VpcId: "Vpc", CidrBlock: "10.0.1.0/24" });
    expect(attrs.Listener).toEqual({ LoadBalancerArn: "Alb" });
  });

  it("resolves intrinsics nested in arrays and objects", () => {
    const attrs = resolveTemplateAttrs(
      tmpl([
        { logicalId: "Inst", type: "AWS::EC2::Instance", properties: { SecurityGroupIds: [{ Ref: "SgA" }, { Ref: "SgB" }], Nested: { SubnetId: { Ref: "Sn" } } } },
      ]),
    );
    expect(attrs.Inst.SecurityGroupIds).toEqual(["SgA", "SgB"]);
    expect(attrs.Inst.Nested).toEqual({ SubnetId: "Sn" });
  });
});

describe("live edges from a CloudFormation template (#784)", () => {
  it("reconstructs containment + edges from resolved template attrs", () => {
    const template = tmpl([
      { logicalId: "Vpc", type: "AWS::EC2::VPC", properties: { CidrBlock: "10.0.0.0/16" } },
      { logicalId: "Subnet", type: "AWS::EC2::Subnet", properties: { VpcId: { Ref: "Vpc" } } },
      { logicalId: "Sg", type: "AWS::EC2::SecurityGroup", properties: { VpcId: { Ref: "Vpc" } } },
      { logicalId: "Inst", type: "AWS::EC2::Instance", properties: { SubnetId: { Ref: "Subnet" }, SecurityGroupIds: [{ Ref: "Sg" }] } },
    ]);
    const attrsById = resolveTemplateAttrs(template);
    const nodes: IRNode[] = template.resources.map((r) => ({ id: r.logicalId, kind: r.type, lexicon: "aws", attrs: attrsById[r.logicalId] }));

    const { edges, containment, dangling } = reconstructEdges(nodes, awsReferenceCatalog);
    // containment: subnet and sg are inside the VPC; the instance is inside the subnet
    expect(containment).toContainEqual({ child: "Subnet", parent: "Vpc", label: "in VPC" });
    expect(containment).toContainEqual({ child: "Sg", parent: "Vpc", label: "in VPC" });
    expect(containment).toContainEqual({ child: "Inst", parent: "Subnet", label: "in subnet" });
    // edge: the instance references the security group
    expect(edges).toContainEqual({ from: "Inst", to: "Sg", kind: "ref", viaAttr: "sg" });
    expect(dangling).toEqual([]);
  });
});
