import { FargateService, Ref } from "@intentius/chant-lexicon-aws";
import { clusterArn, listenerArn, albSgId, executionRoleArn, vpcId, privateSubnet1, privateSubnet2 } from "./params";

export const api = FargateService({
  clusterArn: Ref(clusterArn),
  listenerArn: Ref(listenerArn),
  albSecurityGroupId: Ref(albSgId),
  executionRoleArn: Ref(executionRoleArn),
  vpcId: Ref(vpcId),
  privateSubnetIds: [Ref(privateSubnet1), Ref(privateSubnet2)],
  image: "mccutchen/go-httpbin",
  containerPort: 8080,
  priority: 100,
  pathPatterns: ["/api", "/api/*"],
  healthCheckPath: "/api/get",
  environment: { PREFIX: "/api" },
});
