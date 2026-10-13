/**
 * The agent: a collector on every node, sending to the gateway.
 *
 * Both exporters come from the gateway's declaration. Traces go through the
 * `loadbalancing` exporter, which watches the gateway's headless Service and
 * sends every span of a trace to the same replica; the composite adds the
 * Role that lets the agent watch those Endpoints. Metrics and logs need no
 * such routing and go to the gateway's ClusterIP Service.
 */
import { OtelCollector, gatewayExporter } from "@intentius/chant-lexicon-k8s";
import { Pipeline } from "@intentius/chant-lexicon-otel";
import { agentOtlp, agentMemoryLimiter, agentBatch, agentHealth } from "./agent-components";
import { gateway } from "./gateway";
import { NAMESPACE } from "./namespace";

const byTrace = gatewayExporter(gateway, { loadBalance: true });
const toGateway = gatewayExporter(gateway);
const processors = [agentMemoryLimiter, agentBatch];

export const agent = OtelCollector({
  name: "otel-agent",
  namespace: NAMESPACE,
  config: [
    agentHealth,
    new Pipeline({ signal: "traces", receivers: [agentOtlp], processors, exporters: [byTrace] }),
    new Pipeline({ signal: "metrics", receivers: [agentOtlp], processors, exporters: [toGateway] }),
    new Pipeline({ signal: "logs", receivers: [agentOtlp], processors, exporters: [toGateway] }),
  ],
});
