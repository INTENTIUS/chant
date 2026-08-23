import { output, agentCoreDefaultEndpointArn } from "@intentius/chant-lexicon-aws";
import { agent } from "./agent";

// The identifiers a version-promotion capability (deferred, see README) would
// eventually need — the Runtime's ARN/version — plus the managed DEFAULT
// endpoint clients invoke. No CloudFormation attribute carries that endpoint's
// ARN, so it is derived from the Runtime ARN (#978).
export const runtimeArn = output(agent.runtime.AgentRuntimeArn, "RuntimeArn");
export const runtimeVersion = output(agent.runtime.AgentRuntimeVersion, "RuntimeVersion");
export const defaultEndpointArn = output(agentCoreDefaultEndpointArn(agent.runtime), "DefaultEndpointArn");
export const gatewayUrl = output(agent.gateway.GatewayUrl, "GatewayUrl");
