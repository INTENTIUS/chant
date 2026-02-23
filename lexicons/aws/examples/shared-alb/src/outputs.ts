import { output } from "@intentius/chant-lexicon-aws";
import { network } from "./network";
import { shared } from "./alb";

// ALB outputs — service stacks reference these
export const clusterArn = output(shared.cluster.Arn, "ClusterArn");
export const listenerArn = output(shared.listener.ListenerArn, "ListenerArn");
export const albSgId = output(shared.albSg.GroupId, "AlbSgId");
export const executionRoleArn = output(shared.executionRole.Arn, "ExecutionRoleArn");
export const albDnsName = output(shared.alb.DNSName, "AlbDnsName");

// VPC outputs — service stacks need these for task networking
export const vpcId = output(network.vpc.VpcId, "VpcId");
export const privateSubnet1 = output(network.privateSubnet1.SubnetId, "PrivateSubnet1");
export const privateSubnet2 = output(network.privateSubnet2.SubnetId, "PrivateSubnet2");
