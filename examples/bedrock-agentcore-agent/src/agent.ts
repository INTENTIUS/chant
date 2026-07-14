import { AgentCoreAgent } from "@intentius/chant-lexicon-aws";

// The composite/base path from #882: Runtime + RuntimeEndpoint + Memory +
// Gateway/GatewayTarget + WorkloadIdentity + IAM, wired as one bundle that
// serializes to a single CloudFormation stack. `containerUri` is the ECR
// image already built and pushed for the agent — build/publish stay out of
// scope for this base path (see README).
export const agent = AgentCoreAgent({
  name: "support-agent",
  containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/support-agent:latest",
  environmentVariables: {
    LOG_LEVEL: "info",
  },
});
