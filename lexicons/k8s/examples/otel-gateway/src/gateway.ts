/**
 * The gateway: two collector replicas behind a ClusterIP Service and a
 * headless Service, where tail gatewaySampling happens.
 *
 * Tail gatewaySampling has to see every span of a trace, so the agents route traces
 * to the replicas by trace id (see agent.ts).
 */
import { OtelCollectorGateway } from "@intentius/chant-lexicon-k8s";
import { Pipeline } from "@intentius/chant-lexicon-otel";
import { gatewayOtlp, gatewayMemoryLimiter, gatewayBatch, gatewayHealth, gatewaySampling, gatewayDebug } from "./gateway-components";
import { NAMESPACE } from "./namespace";

export const gateway = OtelCollectorGateway({
  name: "otel-gateway",
  namespace: NAMESPACE,
  replicas: 2,
  config: [
    gatewayHealth,
    new Pipeline({ signal: "traces", receivers: [gatewayOtlp], processors: [gatewayMemoryLimiter, gatewaySampling, gatewayBatch], exporters: [gatewayDebug] }),
    new Pipeline({ signal: "metrics", receivers: [gatewayOtlp], processors: [gatewayMemoryLimiter, gatewayBatch], exporters: [gatewayDebug] }),
    new Pipeline({ signal: "logs", receivers: [gatewayOtlp], processors: [gatewayMemoryLimiter, gatewayBatch], exporters: [gatewayDebug] }),
  ],
});
