import { output } from "@intentius/chant-lexicon-aws";
import { network } from "./network";
import { shared } from "./shared";
import { fs, accessPoint } from "./efs";

export const vpcId = output(network.vpc.VpcId, "VpcId");
export const privateSubnet1 = output(network.privateSubnet1.SubnetId, "PrivateSubnet1");
export const privateSubnet2 = output(network.privateSubnet2.SubnetId, "PrivateSubnet2");
export const clusterArn = output(shared.cluster.Arn, "ClusterArn");
export const listenerArn = output(shared.listener.ListenerArn, "ListenerArn");
export const albSgId = output(shared.albSg.GroupId, "AlbSgId");
export const executionRoleArn = output(shared.executionRole.Arn, "ExecutionRoleArn");
export const efsId = output(fs.FileSystemId, "EfsId");
export const accessPointId = output(accessPoint.AccessPointId, "AccessPointId");
export const albDnsName = output(shared.alb.DNSName, "AlbDnsName");
