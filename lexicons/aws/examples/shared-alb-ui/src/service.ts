import { FargateService, Ref, Parameter } from "@intentius/chant-lexicon-aws";
import { clusterArn, listenerArn, albSgId, executionRoleArn, vpcId, privateSubnet1, privateSubnet2 } from "./params";

export const image = new Parameter("String", {
  description: "Container image URI",
  defaultValue: "nginx:latest",
});

export const ui = FargateService({
  clusterArn: Ref(clusterArn),
  listenerArn: Ref(listenerArn),
  albSecurityGroupId: Ref(albSgId),
  executionRoleArn: Ref(executionRoleArn),
  vpcId: Ref(vpcId),
  privateSubnetIds: [Ref(privateSubnet1), Ref(privateSubnet2)],
  image: Ref(image),
  priority: 200,
  pathPatterns: ["/", "/*"],
});
