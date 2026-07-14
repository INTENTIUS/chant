import { output } from "@intentius/chant-lexicon-aws";
import { agent } from "./agent";

// The identifiers a version-promotion capability (deferred, see README) would
// eventually need — the Runtime's ARN/version and the endpoint it repoints.
export const runtimeArn = output(agent.runtime.AgentRuntimeArn, "RuntimeArn");
export const runtimeVersion = output(agent.runtime.AgentRuntimeVersion, "RuntimeVersion");
export const endpointArn = output(agent.endpoint.AgentRuntimeEndpointArn, "EndpointArn");
export const gatewayUrl = output(agent.gateway.GatewayUrl, "GatewayUrl");
