import { AgentCoreAgent } from "@intentius/chant-lexicon-aws";

// The composite/base path from #882: Runtime + Memory + Gateway/GatewayTarget
// + WorkloadIdentity + IAM, wired as one bundle that serializes to a single
// CloudFormation stack. `containerUri` is the ECR image already built and
// pushed for the agent — build/publish stay out of scope for this base path
// (see README).
//
// No RuntimeEndpoint here. AgentCore provisions a managed DEFAULT endpoint with
// the Runtime and repoints it at each new version itself; a CloudFormation
// DEFAULT endpoint duplicates it and races the Runtime's version-READY on a
// real apply (#978). Pass `endpointName: "PROD"` for an explicit alias once a
// version-promotion flow needs one.
export const agent = AgentCoreAgent({
  name: "support-agent",
  containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/support-agent:latest",
  environmentVariables: {
    LOG_LEVEL: "info",
  },
});
