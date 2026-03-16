import { FargateService } from "@intentius/chant-lexicon-aws";
import { network } from "./network";
import { shared } from "./shared";

export const api = FargateService({
  clusterArn: shared.cluster.Arn,
  listenerArn: shared.listener.ListenerArn,
  albSecurityGroupId: shared.albSg.GroupId,
  executionRoleArn: shared.executionRole.Arn,
  vpcId: network.vpc.VpcId,
  privateSubnetIds: [network.privateSubnet1.SubnetId, network.privateSubnet2.SubnetId],
  image: "mccutchen/go-httpbin",
  containerPort: 8080,
  priority: 100,
  pathPatterns: ["/api", "/api/*"],
  healthCheckPath: "/api/get",
  environment: { PREFIX: "/api" },
});

export const ui = FargateService({
  clusterArn: shared.cluster.Arn,
  listenerArn: shared.listener.ListenerArn,
  albSecurityGroupId: shared.albSg.GroupId,
  executionRoleArn: shared.executionRole.Arn,
  vpcId: network.vpc.VpcId,
  privateSubnetIds: [network.privateSubnet1.SubnetId, network.privateSubnet2.SubnetId],
  image: "nginx:latest",
  priority: 200,
  pathPatterns: ["/", "/*"],
});
