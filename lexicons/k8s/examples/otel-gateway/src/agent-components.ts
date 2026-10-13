/**
 * The agent's own components: OTLP in on both protocols from the pods on its
 * node, a memory limiter, a short batch, and a health check for the probes.
 * Its exporters come from the gateway's declaration, in agent.ts.
 */
import {
  OtlpReceiver,
  MemoryLimiterProcessor,
  BatchProcessor,
  HealthCheckExtension,
  type OtlpReceiverConfig,
} from "@intentius/chant-lexicon-otel";

const protocols: OtlpReceiverConfig["protocols"] = {
  grpc: { endpoint: "0.0.0.0:4317" },
  http: { endpoint: "0.0.0.0:4318" },
};

const agentOtlp = new OtlpReceiver({ protocols });
const agentMemoryLimiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
const agentBatch = new BatchProcessor({ timeout: "1s" });
const agentHealth = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

export { agentOtlp, agentMemoryLimiter, agentBatch, agentHealth };
