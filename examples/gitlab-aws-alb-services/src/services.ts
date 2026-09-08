import { FargateService, Ref, Parameter } from "@intentius/chant-lexicon-aws";
import { clusterArn, listenerArn, albSgId, executionRoleArn, vpcId, privateSubnet1, privateSubnet2 } from "./params";

// One image parameter per service. Both are filled by the deploy job from the
// infra stack's ECR outputs plus the commit tag.
export const apiImage = new Parameter("String", {
  description: "API container image URI",
  defaultValue: "mccutchen/go-httpbin",
});

export const uiImage = new Parameter("String", {
  description: "UI container image URI",
  defaultValue: "nginx:latest",
});

// Two services on one listener. The priorities are what order the rules:
// the API's /api prefix is evaluated first, and the UI's /* catches the rest.
export const api = FargateService({
  clusterArn: Ref(clusterArn),
  listenerArn: Ref(listenerArn),
  albSecurityGroupId: Ref(albSgId),
  executionRoleArn: Ref(executionRoleArn),
  vpcId: Ref(vpcId),
  privateSubnetIds: [Ref(privateSubnet1), Ref(privateSubnet2)],
  image: Ref(apiImage),
  containerPort: 8080,
  priority: 100,
  pathPatterns: ["/api", "/api/*"],
  healthCheckPath: "/api/get",
  environment: { PREFIX: "/api" },
});

export const ui = FargateService({
  clusterArn: Ref(clusterArn),
  listenerArn: Ref(listenerArn),
  albSecurityGroupId: Ref(albSgId),
  executionRoleArn: Ref(executionRoleArn),
  vpcId: Ref(vpcId),
  privateSubnetIds: [Ref(privateSubnet1), Ref(privateSubnet2)],
  image: Ref(uiImage),
  priority: 200,
  pathPatterns: ["/", "/*"],
});
