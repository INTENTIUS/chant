import type { ReferenceCatalog } from "@intentius/chant/lexicon";

/**
 * AWS reference catalog (#778, epic #776 v1) — how observed AWS resources
 * reference each other, so `chant graph --live` can reconstruct the topology.
 *
 * Keyed to the per-resource describe/export attribute shape (`VpcId`,
 * `SecurityGroups[].GroupId`, `TargetGroupArn`, …), not the thin
 * `describe-stack-resources` metadata. Enough to draw the canonical 3-tier VPC
 * (internet → ALB → ECS service → RDS, with SG attachments). `containment`
 * relations (subnet ∈ VPC) feed #779's boundary boxes; `reference` relations are
 * edges.
 */
export const awsReferenceCatalog: ReferenceCatalog = {
  identities: [
    { kind: "AWS::EC2::VPC", ids: ["VpcId"] },
    { kind: "AWS::EC2::Subnet", ids: ["SubnetId"] },
    { kind: "AWS::EC2::SecurityGroup", ids: ["GroupId"] },
    { kind: "AWS::EC2::NetworkInterface", ids: ["NetworkInterfaceId"] },
    { kind: "AWS::EC2::Instance", ids: ["InstanceId"] },
    { kind: "AWS::EC2::InternetGateway", ids: ["InternetGatewayId"] },
    { kind: "AWS::EC2::NatGateway", ids: ["NatGatewayId"] },
    { kind: "AWS::EC2::RouteTable", ids: ["RouteTableId"] },
    { kind: "AWS::EC2::LaunchTemplate", ids: ["LaunchTemplateId", "LaunchTemplateName"] },
    { kind: "AWS::ElasticLoadBalancingV2::LoadBalancer", ids: ["LoadBalancerArn", "DNSName"] },
    { kind: "AWS::ElasticLoadBalancingV2::TargetGroup", ids: ["TargetGroupArn"] },
    { kind: "AWS::ECS::Cluster", ids: ["ClusterArn", "ClusterName"] },
    { kind: "AWS::ECS::Service", ids: ["ServiceArn"] },
    { kind: "AWS::ECS::TaskDefinition", ids: ["TaskDefinitionArn"] },
    { kind: "AWS::RDS::DBInstance", ids: ["DBInstanceArn", "Endpoint.Address"] },
  ],
  refs: [
    // ── containment (→ boundary boxes, #779) ──
    { from: "AWS::EC2::Subnet", path: "VpcId", targetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::SecurityGroup", path: "VpcId", targetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::RouteTable", path: "VpcId", targetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::Instance", path: "SubnetId", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet", viaAttr: "SubnetId" },
    { from: "AWS::EC2::NatGateway", path: "SubnetId", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet", viaAttr: "SubnetId" },
    { from: "AWS::ElasticLoadBalancingV2::LoadBalancer", path: "AvailabilityZones[].SubnetId", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet" },
    { from: "AWS::ElasticLoadBalancingV2::TargetGroup", path: "VpcId", targetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::ECS::Service", path: "NetworkConfiguration.AwsvpcConfiguration.Subnets[]", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet" },
    { from: "AWS::RDS::DBInstance", path: "DBSubnetGroup.Subnets[].SubnetIdentifier", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet" },

    // ── references (→ edges) ──
    { from: "AWS::EC2::Instance", path: "SecurityGroups[].GroupId", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg", viaAttr: "SecurityGroupIds" },
    { from: "AWS::EC2::Instance", path: "SecurityGroupIds[]", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg", viaAttr: "SecurityGroupIds" },
    // Security groups reached indirectly, through a launch template — the hop a
    // flat describe-instances sweep misses, and the reason `effectiveIngress`
    // exists as a fold rather than a passthrough.
    { from: "AWS::EC2::Instance", path: "LaunchTemplate.LaunchTemplateId", targetKind: "AWS::EC2::LaunchTemplate", relation: "reference", label: "from template", viaAttr: "LaunchTemplateId" },
    { from: "AWS::EC2::Instance", path: "LaunchTemplateId", targetKind: "AWS::EC2::LaunchTemplate", relation: "reference", label: "from template", viaAttr: "LaunchTemplateId" },
    { from: "AWS::EC2::LaunchTemplate", path: "LaunchTemplateData.SecurityGroupIds[]", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg", viaAttr: "SecurityGroupIds" },
    { from: "AWS::EC2::LaunchTemplate", path: "SecurityGroupIds[]", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg", viaAttr: "SecurityGroupIds" },
    // The routing chain `internetFacing` walks. Route and association carry no
    // physical id of their own, so they are only ever the `from` side.
    { from: "AWS::EC2::Route", path: "RouteTableId", targetKind: "AWS::EC2::RouteTable", relation: "reference", label: "in table", viaAttr: "RouteTableId" },
    { from: "AWS::EC2::SubnetRouteTableAssociation", path: "SubnetId", targetKind: "AWS::EC2::Subnet", relation: "reference", label: "associates", viaAttr: "SubnetId" },
    { from: "AWS::EC2::SubnetRouteTableAssociation", path: "RouteTableId", targetKind: "AWS::EC2::RouteTable", relation: "reference", label: "to table", viaAttr: "RouteTableId" },
    { from: "AWS::EC2::SecurityGroup", path: "IpPermissions[].UserIdGroupPairs[].GroupId", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "allows" },
    // An ENI is where a security group is attached and where an instance's
    // networking actually lives, so both edges are what make "unused" and
    // "reachable" answerable from the graph rather than from a provider sweep.
    { from: "AWS::EC2::NetworkInterface", path: "Groups[].GroupId", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg", viaAttr: "Groups" },
    { from: "AWS::EC2::NetworkInterface", path: "Attachment.InstanceId", targetKind: "AWS::EC2::Instance", relation: "reference", label: "attached to", viaAttr: "Attachment" },
    // Containment rules carry a traversal name so `->`/`<-` can cross them
    // (#1275). Without one `reconstructEdges` records the pair as a boundary
    // hint and emits no edge, which reads as "nothing is in here" rather than
    // as "this relationship is not traversable".
    //
    // `AWS::EC2::Instance -> Subnet` already had one; the ENI, which is the
    // same relationship for the same reason, did not. The gap was measurable: `kind:EC2::Subnet !<-kind:EC2::NetworkInterface` —
    // the query the grammar exists to express — matched 23 of 23 subnets on an
    // estate where 8 of 13 are empty, because no ENI ever produced an edge. An
    // inert negation is indistinguishable from one that found nothing.
    //
    // Scoped to "occupies a subnet", matching the exception that already
    // existed. Containment INTO a VPC stays a boundary hint — a test asserts
    // that explicitly, and widening it is a separate decision.
    { from: "AWS::EC2::NetworkInterface", path: "SubnetId", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet", viaAttr: "SubnetId" },
    { from: "AWS::EC2::Route", path: "GatewayId", targetKind: "AWS::EC2::InternetGateway", relation: "reference", label: "via", viaAttr: "GatewayId" },
    { from: "AWS::EC2::Route", path: "NatGatewayId", targetKind: "AWS::EC2::NatGateway", relation: "reference", label: "via" },
    { from: "AWS::ElasticLoadBalancingV2::LoadBalancer", path: "SecurityGroups[]", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg" },
    { from: "AWS::ElasticLoadBalancingV2::Listener", path: "LoadBalancerArn", targetKind: "AWS::ElasticLoadBalancingV2::LoadBalancer", relation: "reference", label: "on" },
    { from: "AWS::ElasticLoadBalancingV2::Listener", path: "DefaultActions[].TargetGroupArn", targetKind: "AWS::ElasticLoadBalancingV2::TargetGroup", relation: "reference", label: "forwards to" },
    { from: "AWS::ECS::Service", path: "ClusterArn", targetKind: "AWS::ECS::Cluster", relation: "reference", label: "in cluster" },
    { from: "AWS::ECS::Service", path: "TaskDefinition", targetKind: "AWS::ECS::TaskDefinition", relation: "reference", label: "runs" },
    { from: "AWS::ECS::Service", path: "LoadBalancers[].TargetGroupArn", targetKind: "AWS::ElasticLoadBalancingV2::TargetGroup", relation: "reference", label: "registered in" },
    { from: "AWS::ECS::Service", path: "NetworkConfiguration.AwsvpcConfiguration.SecurityGroups[]", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg" },
    { from: "AWS::RDS::DBInstance", path: "VpcSecurityGroups[].VpcSecurityGroupId", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg" },

    // ── CloudFormation *template* property paths (#784) ──
    // `enrichLiveAttrs` resolves the deployed template's `{Ref}`/`{Fn::GetAtt}`
    // intrinsics to bare logical ids (= node ids), so these match by node id; the
    // property names are the CFN template shape (SecurityGroupIds, Cluster, …),
    // which differs from the describe/SDK shape above. No targetKind needed —
    // logical ids are unique.
    { from: "AWS::EC2::Subnet", path: "VpcId", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::SecurityGroup", path: "VpcId", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::RouteTable", path: "VpcId", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::Instance", path: "SubnetId", relation: "containment", label: "in subnet" },
    { from: "AWS::EC2::Instance", path: "SecurityGroupIds[]", relation: "reference", label: "sg" },
    { from: "AWS::EC2::NatGateway", path: "SubnetId", relation: "containment", label: "in subnet", viaAttr: "SubnetId" },
    { from: "AWS::EC2::Route", path: "RouteTableId", relation: "reference", label: "in" },
    { from: "AWS::EC2::Route", path: "GatewayId", relation: "reference", label: "via" },
    { from: "AWS::EC2::Route", path: "NatGatewayId", relation: "reference", label: "via" },
    { from: "AWS::ElasticLoadBalancingV2::LoadBalancer", path: "Subnets[]", relation: "containment", label: "in subnet" },
    { from: "AWS::ElasticLoadBalancingV2::LoadBalancer", path: "SecurityGroups[]", relation: "reference", label: "sg" },
    { from: "AWS::ElasticLoadBalancingV2::TargetGroup", path: "VpcId", relation: "containment", label: "in VPC" },
    { from: "AWS::ElasticLoadBalancingV2::Listener", path: "LoadBalancerArn", relation: "reference", label: "on" },
    { from: "AWS::ElasticLoadBalancingV2::Listener", path: "DefaultActions[].TargetGroupArn", relation: "reference", label: "forwards to" },
    { from: "AWS::ECS::Service", path: "Cluster", relation: "reference", label: "in cluster" },
    { from: "AWS::ECS::Service", path: "TaskDefinition", relation: "reference", label: "runs" },
    { from: "AWS::ECS::Service", path: "LoadBalancers[].TargetGroupArn", relation: "reference", label: "registered in" },
    { from: "AWS::RDS::DBInstance", path: "DBSubnetGroupName", relation: "reference", label: "subnets" },
    { from: "AWS::RDS::DBInstance", path: "VPCSecurityGroups[]", relation: "reference", label: "sg" },
  ],
};
