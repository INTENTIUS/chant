/**
 * The CC lane's canonical example, app half (chant#1198 / behold#100).
 *
 * A security group and the instance inside it, placed in the network half's
 * private subnet. Two things this half is carrying for the lane:
 *
 *   - the SECURITY GROUP is the one deep-readable type in the cloud half
 *     (chant#1269 — read from `ec2 describe-security-groups` rather than Cloud
 *     Control), so it is the drift target #1207 proved and the only resource
 *     here whose live properties can be compared field by field;
 *   - the cross-stack reference to `privateSubnet` becomes a CloudFormation
 *     `ImportValue`, which is what behold's logical projection has to bridge
 *     to place this component's card inside the network's subnet box.
 */
import { SecurityGroup, SecurityGroup_Ingress, Instance } from "@intentius/chant-lexicon-aws";
import { vpc, privateSubnet } from "../cc-network/network";

export const appSecurityGroup = new SecurityGroup({
  GroupDescription: "cc-app in-VPC access to the app instance",
  VpcId: vpc.VpcId,
  SecurityGroupIngress: [
    new SecurityGroup_Ingress({
      IpProtocol: "tcp",
      FromPort: 443,
      ToPort: 443,
      CidrIp: "10.42.0.0/16",
    }),
  ],
});

// The workload itself: nothing in the estate references an EC2 instance, so
// COR004 reads the leaf of the graph as dead code.
// chant-disable-next-line COR004
export const appInstance = new Instance({
  ImageId: "ami-0c02fb55956c7d316",
  InstanceType: "t3.micro",
  SubnetId: privateSubnet.SubnetId,
  SecurityGroupIds: [appSecurityGroup.GroupId],
});
