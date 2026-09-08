import { Parameter } from "@intentius/chant-lexicon-aws";

export const environment = new Parameter("String", {
  description: "Runtime environment",
  defaultValue: "dev",
});

// Shared ALB stack outputs — pass via --parameter-overrides at deploy time
export const clusterArn = new Parameter("String", { description: "ECS Cluster ARN" });
export const listenerArn = new Parameter("String", { description: "ALB Listener ARN" });
export const albSgId = new Parameter("String", { description: "ALB Security Group ID" });
export const executionRoleArn = new Parameter("String", { description: "Execution Role ARN" });
export const vpcId = new Parameter("String", { description: "VPC ID" });
export const privateSubnet1 = new Parameter("String", { description: "Private Subnet 1 ID" });
export const privateSubnet2 = new Parameter("String", { description: "Private Subnet 2 ID" });
