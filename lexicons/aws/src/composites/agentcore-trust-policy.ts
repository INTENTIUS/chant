// The service principal Bedrock AgentCore assumes to run a Runtime and to
// invoke Gateway targets. Same shape as ecs-trust-policy.ts/lambdaTrustPolicy
// in lambda-function.ts, one principal shared by both AgentCore-hosted roles.
export const agentCoreTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "bedrock-agentcore.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};
