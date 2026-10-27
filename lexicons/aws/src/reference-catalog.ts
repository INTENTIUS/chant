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
    // Targets of the CloudFormation-shape rules an index needs (#4522, the
    // missing rules counted on INTENTIUS/behold#1023). Over an index each
    // node is also matched by its Cloud Control identifier and its cloud ids,
    // so a role's ARN joins even though the deep hooks prune `Arn`.
    { kind: "AWS::RDS::DBSubnetGroup", ids: ["DBSubnetGroupName"] },
    { kind: "AWS::IAM::Role", ids: ["Arn", "RoleName"] },
    { kind: "AWS::EC2::EIP", ids: ["AllocationId", "PublicIp"] },
    { kind: "AWS::Logs::LogGroup", ids: ["LogGroupName", "Arn"] },
    { kind: "AWS::Route53::HostedZone", ids: ["Id"] },
    { kind: "AWS::EKS::Cluster", ids: ["Name", "Arn"] },
    { kind: "AWS::CloudFormation::Stack", ids: ["StackId"] },
  ],
  refs: [
    // ── containment (→ boundary boxes, #779) ──
    { from: "AWS::EC2::Subnet", path: "VpcId", targetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::SecurityGroup", path: "VpcId", targetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::RouteTable", path: "VpcId", targetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::Instance", path: "SubnetId", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet", viaAttr: "SubnetId" },
    // An instance is in a VPC, and `describe-instances` says so directly. The
    // other three kinds that sit in a VPC — subnet, security group, route table
    // — all had this rule; the instance did not, so the estate's own topology
    // was missing its most-asked-about member. Nothing derived it either: the
    // instance reached its VPC only through its subnet, two hops, which a
    // one-hop `<-` cannot cross.
    { from: "AWS::EC2::Instance", path: "VpcId", targetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::NatGateway", path: "SubnetId", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet" },
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
    { from: "AWS::EC2::NetworkInterface", path: "SubnetId", targetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet" },
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
    // logical ids are unique. Over an index (#4522) the same paths hold physical
    // values, some of them names, so each carries the `indexedTargetKind` it
    // takes there (ruled on INTENTIUS/behold#1023 Q4).
    { from: "AWS::EC2::Subnet", path: "VpcId", indexedTargetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::SecurityGroup", path: "VpcId", indexedTargetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::RouteTable", path: "VpcId", indexedTargetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::EC2::Instance", path: "SubnetId", indexedTargetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet" },
    { from: "AWS::EC2::Instance", path: "SecurityGroupIds[]", indexedTargetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg" },
    { from: "AWS::EC2::NatGateway", path: "SubnetId", indexedTargetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet" },
    { from: "AWS::EC2::Route", path: "RouteTableId", indexedTargetKind: "AWS::EC2::RouteTable", relation: "reference", label: "in" },
    { from: "AWS::EC2::Route", path: "GatewayId", indexedTargetKind: "AWS::EC2::InternetGateway", relation: "reference", label: "via" },
    { from: "AWS::EC2::Route", path: "NatGatewayId", indexedTargetKind: "AWS::EC2::NatGateway", relation: "reference", label: "via" },
    { from: "AWS::ElasticLoadBalancingV2::LoadBalancer", path: "Subnets[]", indexedTargetKind: "AWS::EC2::Subnet", relation: "containment", label: "in subnet" },
    { from: "AWS::ElasticLoadBalancingV2::LoadBalancer", path: "SecurityGroups[]", indexedTargetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg" },
    { from: "AWS::ElasticLoadBalancingV2::TargetGroup", path: "VpcId", indexedTargetKind: "AWS::EC2::VPC", relation: "containment", label: "in VPC" },
    { from: "AWS::ElasticLoadBalancingV2::Listener", path: "LoadBalancerArn", indexedTargetKind: "AWS::ElasticLoadBalancingV2::LoadBalancer", relation: "reference", label: "on" },
    { from: "AWS::ElasticLoadBalancingV2::Listener", path: "DefaultActions[].TargetGroupArn", indexedTargetKind: "AWS::ElasticLoadBalancingV2::TargetGroup", relation: "reference", label: "forwards to" },
    { from: "AWS::ECS::Service", path: "Cluster", indexedTargetKind: "AWS::ECS::Cluster", relation: "reference", label: "in cluster" },
    { from: "AWS::ECS::Service", path: "TaskDefinition", indexedTargetKind: "AWS::ECS::TaskDefinition", relation: "reference", label: "runs" },
    { from: "AWS::ECS::Service", path: "LoadBalancers[].TargetGroupArn", indexedTargetKind: "AWS::ElasticLoadBalancingV2::TargetGroup", relation: "reference", label: "registered in" },
    { from: "AWS::RDS::DBInstance", path: "DBSubnetGroupName", indexedTargetKind: "AWS::RDS::DBSubnetGroup", relation: "reference", label: "subnets" },
    { from: "AWS::RDS::DBInstance", path: "VPCSecurityGroups[]", indexedTargetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "sg" },

    // ── CloudFormation property shape, as Cloud Control returns it (#4522) ──
    // The rules INTENTIUS/behold#1023's count found missing for an index of
    // example-three-cloud. Targeted, so they hold over physical values and over
    // logical ids alike.
    { from: "AWS::EC2::VPCGatewayAttachment", path: "VpcId", targetKind: "AWS::EC2::VPC", relation: "reference", label: "attaches to" },
    { from: "AWS::EC2::VPCGatewayAttachment", path: "InternetGatewayId", targetKind: "AWS::EC2::InternetGateway", relation: "reference", label: "attaches" },
    { from: "AWS::EC2::NatGateway", path: "AllocationId", targetKind: "AWS::EC2::EIP", relation: "reference", label: "address" },
    { from: "AWS::ECS::TaskDefinition", path: "ExecutionRoleArn", targetKind: "AWS::IAM::Role", relation: "reference", label: "execution role" },
    { from: "AWS::ECS::TaskDefinition", path: "TaskRoleArn", targetKind: "AWS::IAM::Role", relation: "reference", label: "task role" },
    { from: "AWS::ECS::TaskDefinition", path: "ContainerDefinitions[].LogConfiguration.Options.awslogs-group", targetKind: "AWS::Logs::LogGroup", relation: "reference", label: "logs to" },
    { from: "AWS::EC2::SecurityGroup", path: "SecurityGroupIngress[].SourceSecurityGroupId", targetKind: "AWS::EC2::SecurityGroup", relation: "reference", label: "allows" },
    { from: "AWS::Route53::RecordSet", path: "HostedZoneId", targetKind: "AWS::Route53::HostedZone", relation: "containment", label: "in zone" },
  ],
  // Tags that name a cloud id in their key or value (behold#1023 Q5). Used
  // over indexed nodes only. No rule matches equal tag values in general.
  tagRefs: [
    { key: "aws:cloudformation:stack-id", read: "value", targetKind: "AWS::CloudFormation::Stack", label: "in stack" },
    { key: "aws:eks:cluster-name", read: "value", targetKind: "AWS::EKS::Cluster", label: "cluster" },
    { key: "eks:cluster-name", read: "value", targetKind: "AWS::EKS::Cluster", label: "cluster" },
    { key: "kubernetes.io/cluster/", read: "key-suffix", targetKind: "AWS::EKS::Cluster", label: "cluster" },
  ],
};
