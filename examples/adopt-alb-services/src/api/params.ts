import { Parameter } from "@intentius/chant-lexicon-aws";

// Shared-alb stack outputs, declared as CloudFormation parameters. At deploy
// time the bespoke pipeline filled these with `describe-stacks | jq`; the api
// component fills them with stackOutput("shared-alb", ...) wiring instead.
export const clusterArn = new Parameter("String", { description: "ECS Cluster ARN" });
export const listenerArn = new Parameter("String", { description: "ALB Listener ARN" });
export const albSgId = new Parameter("String", { description: "ALB Security Group ID" });
export const executionRoleArn = new Parameter("String", { description: "Execution Role ARN" });
export const vpcId = new Parameter("String", { description: "VPC ID" });
export const privateSubnet1 = new Parameter("String", { description: "Private Subnet 1 ID" });
export const privateSubnet2 = new Parameter("String", { description: "Private Subnet 2 ID" });
