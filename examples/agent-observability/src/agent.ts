/**
 * The agent: a collector on every node, taking OTLP from the pods beside it.
 *
 * Both exporters come from the gateway's declaration. Traces go through the
 * `loadbalancing` exporter, which watches the gateway's headless Service and
 * sends every span of a trace to the same replica. Metrics and logs need no
 * such routing and go to the gateway's ClusterIP Service.
 */
import { OtelCollector, gatewayExporter } from "@intentius/chant-lexicon-k8s";
import {
  BatchProcessor,
  HealthCheckExtension,
  MemoryLimiterProcessor,
  OtlpReceiver,
  Pipeline,
  type OtlpReceiverConfig,
} from "@intentius/chant-lexicon-otel";
import { gateway } from "./gateway";
import { NAMESPACE } from "./namespace";

const protocols: OtlpReceiverConfig["protocols"] = {
  grpc: { endpoint: "0.0.0.0:4317" },
  http: { endpoint: "0.0.0.0:4318" },
};

const agentOtlp = new OtlpReceiver({ protocols });
const agentMemoryLimiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
const agentBatch = new BatchProcessor({ timeout: "1s" });
const agentHealth = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

const byTrace = gatewayExporter(gateway, { loadBalance: true, resolver: "k8s" });
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
