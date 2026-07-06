import { Parameter } from "@intentius/chant-lexicon-aws";

// Identical to src/api/params.ts — both services consume the same shared-alb
// outputs. Shared shape, not copied glue.
export const clusterArn = new Parameter("String", { description: "ECS Cluster ARN" });
export const listenerArn = new Parameter("String", { description: "ALB Listener ARN" });
export const albSgId = new Parameter("String", { description: "ALB Security Group ID" });
export const executionRoleArn = new Parameter("String", { description: "Execution Role ARN" });
export const vpcId = new Parameter("String", { description: "VPC ID" });
export const privateSubnet1 = new Parameter("String", { description: "Private Subnet 1 ID" });
export const privateSubnet2 = new Parameter("String", { description: "Private Subnet 2 ID" });
