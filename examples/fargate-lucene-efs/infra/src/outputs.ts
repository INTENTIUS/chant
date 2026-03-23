import { output } from "@intentius/chant-lexicon-aws";
import { network } from "./network";
import { shared } from "./shared";
import { fs, accessPoint, efsSecurityGroup } from "./efs";

export const vpcId = output(network.vpc.VpcId, "vpcId");
export const privateSubnet1 = output(network.privateSubnet1.SubnetId, "privateSubnet1");
export const privateSubnet2 = output(network.privateSubnet2.SubnetId, "privateSubnet2");
export const clusterArn = output(shared.cluster.Arn, "clusterArn");
export const listenerArn = output(shared.listener.ListenerArn, "listenerArn");
export const albSgId = output(shared.albSg.GroupId, "albSgId");
export const executionRoleArn = output(shared.executionRole.Arn, "executionRoleArn");
export const efsId = output(fs.FileSystemId, "efsId");
export const accessPointId = output(accessPoint.AccessPointId, "accessPointId");
export const albDnsName = output(shared.alb.DNSName, "albDnsName");
export const efsSecurityGroupId = output(efsSecurityGroup.GroupId, "efsSecurityGroupId");
