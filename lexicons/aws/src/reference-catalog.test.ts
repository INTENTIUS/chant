import { describe, it, expect } from "vitest";
import { reconstructEdges } from "@intentius/chant/graph-refs";
import type { IRNode } from "@intentius/chant/graph-ir";
import { awsReferenceCatalog } from "./reference-catalog";

const n = (id: string, kind: string, attrs: Record<string, unknown>): IRNode => ({ id, kind, lexicon: "aws", attrs });

// A canonical 3-tier VPC (managed subgraph): internet → ALB (public subnets) →
// ECS service (private subnets) → RDS, with SG attachments. Attributes are the
// per-resource describe/export shape the catalog targets.
const nodes: IRNode[] = [
  n("vpc", "AWS::EC2::VPC", { VpcId: "vpc-1" }),
  n("pubA", "AWS::EC2::Subnet", { SubnetId: "subnet-pa", VpcId: "vpc-1" }),
  n("pubB", "AWS::EC2::Subnet", { SubnetId: "subnet-pb", VpcId: "vpc-1" }),
  n("privA", "AWS::EC2::Subnet", { SubnetId: "subnet-qa", VpcId: "vpc-1" }),
  n("privB", "AWS::EC2::Subnet", { SubnetId: "subnet-qb", VpcId: "vpc-1" }),
  n("albSg", "AWS::EC2::SecurityGroup", { GroupId: "sg-alb", VpcId: "vpc-1" }),
  n("appSg", "AWS::EC2::SecurityGroup", { GroupId: "sg-app", VpcId: "vpc-1", IpPermissions: [{ UserIdGroupPairs: [{ GroupId: "sg-alb" }] }] }),
  n("alb", "AWS::ElasticLoadBalancingV2::LoadBalancer", { LoadBalancerArn: "arn-alb", AvailabilityZones: [{ SubnetId: "subnet-pa" }, { SubnetId: "subnet-pb" }], SecurityGroups: ["sg-alb"] }),
  n("tg", "AWS::ElasticLoadBalancingV2::TargetGroup", { TargetGroupArn: "arn-tg", VpcId: "vpc-1" }),
  n("listener", "AWS::ElasticLoadBalancingV2::Listener", { LoadBalancerArn: "arn-alb", DefaultActions: [{ TargetGroupArn: "arn-tg" }] }),
  n("cluster", "AWS::ECS::Cluster", { ClusterArn: "arn-cl" }),
  n("taskdef", "AWS::ECS::TaskDefinition", { TaskDefinitionArn: "arn-td" }),
  n("svc", "AWS::ECS::Service", { ServiceArn: "arn-svc", ClusterArn: "arn-cl", TaskDefinition: "arn-td", LoadBalancers: [{ TargetGroupArn: "arn-tg" }], NetworkConfiguration: { AwsvpcConfiguration: { Subnets: ["subnet-qa", "subnet-qb"], SecurityGroups: ["sg-app"] } } }),
  n("rds", "AWS::RDS::DBInstance", { DBInstanceArn: "arn-rds", DBSubnetGroup: { Subnets: [{ SubnetIdentifier: "subnet-qa" }, { SubnetIdentifier: "subnet-qb" }] }, VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-app" }] }),
];

describe("awsReferenceCatalog — golden 3-tier VPC", () => {
  const { edges, containment, dangling } = reconstructEdges(nodes, awsReferenceCatalog);
  const hasEdge = (from: string, to: string, via?: string) =>
    edges.some((e) => e.from === from && e.to === to && (via === undefined || e.viaAttr === via));
  const hasCont = (child: string, parent: string) =>
    containment.some((c) => c.child === child && c.parent === parent);

  it("reconstructs the topology edges", () => {
    expect(hasEdge("svc", "cluster", "in cluster")).toBe(true);
    expect(hasEdge("svc", "taskdef", "runs")).toBe(true);
    expect(hasEdge("svc", "tg", "registered in")).toBe(true);
    expect(hasEdge("svc", "appSg", "sg")).toBe(true);
    expect(hasEdge("listener", "alb", "on")).toBe(true);
    expect(hasEdge("listener", "tg", "forwards to")).toBe(true);
    expect(hasEdge("alb", "albSg", "sg")).toBe(true);
    expect(hasEdge("appSg", "albSg", "allows")).toBe(true);
    expect(hasEdge("rds", "appSg", "sg")).toBe(true);
  });

  it("reconstructs network containment (→ #779 boundaries), not as edges", () => {
    for (const s of ["pubA", "pubB", "privA", "privB", "albSg", "appSg", "tg"]) expect(hasCont(s, "vpc")).toBe(true);
    expect(hasCont("alb", "pubA")).toBe(true);
    expect(hasCont("alb", "pubB")).toBe(true);
    expect(hasCont("svc", "privA")).toBe(true);
    expect(hasCont("rds", "privB")).toBe(true);
    // containment is never an edge
    expect(edges.some((e) => e.to === "vpc")).toBe(false);
  });

  it("has no dangling references — every target is in the observed set", () => {
    expect(dangling).toEqual([]);
  });

  it("reference edges point holder → referenced", () => {
    // e.g. the service references the cluster, not the reverse
    expect(hasEdge("cluster", "svc")).toBe(false);
  });
});
