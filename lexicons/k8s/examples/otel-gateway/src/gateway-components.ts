/**
 * The gateway's components, declared with the otel lexicon.
 *
 * Tail sampling keeps every trace with an error and a quarter of the rest.
 * It waits five seconds after a trace's first span before deciding. The
 * debug exporter prints what is kept; a real deployment would export to a
 * tracing backend instead.
 */
import {
  OtlpReceiver,
  MemoryLimiterProcessor,
  BatchProcessor,
  TailSamplingProcessor,
  DebugExporter,
  HealthCheckExtension,
  type OtlpReceiverConfig,
  type TailSamplingPolicy,
} from "@intentius/chant-lexicon-otel";

const protocols: OtlpReceiverConfig["protocols"] = { grpc: { endpoint: "0.0.0.0:4317" } };

const errors: TailSamplingPolicy = { name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } };
const baseline: TailSamplingPolicy = { name: "baseline", type: "probabilistic", probabilistic: { sampling_percentage: 25 } };
const policies = [errors, baseline];

const gatewayOtlp = new OtlpReceiver({ protocols });
const gatewayMemoryLimiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
const gatewayBatch = new BatchProcessor({ timeout: "5s" });
const gatewaySampling = new TailSamplingProcessor({ decision_wait: "5s", policies });
const gatewayDebug = new DebugExporter({ verbosity: "detailed" });
const gatewayHealth = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

export { gatewayOtlp, gatewayMemoryLimiter, gatewayBatch, gatewayHealth, gatewaySampling, gatewayDebug };
