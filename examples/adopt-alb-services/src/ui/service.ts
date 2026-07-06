import { FargateService, Ref, Parameter } from "@intentius/chant-lexicon-aws";
import { clusterArn, listenerArn, albSgId, executionRoleArn, vpcId, privateSubnet1, privateSubnet2 } from "./params";

export const image = new Parameter("String", {
  description: "Container image URI",
  defaultValue: "mccutchen/go-httpbin",
});

// Same composite as the api service — a Fargate task, ECS service, target group,
// ALB rule, security group, and log group — differing only in its route
// (/ui at priority 200) and prefix. The second service is a second declaration.
export const ui = FargateService({
  clusterArn: Ref(clusterArn),
  listenerArn: Ref(listenerArn),
  albSecurityGroupId: Ref(albSgId),
  executionRoleArn: Ref(executionRoleArn),
  vpcId: Ref(vpcId),
  privateSubnetIds: [Ref(privateSubnet1), Ref(privateSubnet2)],
  image: Ref(image),
  containerPort: 8080,
  priority: 200,
  pathPatterns: ["/ui", "/ui/*"],
  healthCheckPath: "/get",
  environment: { PREFIX: "/ui" },
});
