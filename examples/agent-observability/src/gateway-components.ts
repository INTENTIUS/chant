/**
 * The gateway's plumbing and where each signal leaves it: OTLP in, a memory
 * limiter and a batch, a health check for the probes, and three exporters.
 * Prometheus scrapes the metrics from the `prometheus` exporter on each
 * replica, traces go to Tempo over OTLP gRPC, and logs go to Loki's OTLP
 * endpoint.
 */
import {
  BatchProcessor,
  HealthCheckExtension,
  MemoryLimiterProcessor,
  OtlpExporter,
  OtlpHttpExporter,
  OtlpReceiver,
  PrometheusExporter,
  type OtlpReceiverConfig,
} from "@intentius/chant-lexicon-otel";

const protocols: OtlpReceiverConfig["protocols"] = { grpc: { endpoint: "0.0.0.0:4317" } };
const gatewayOtlp = new OtlpReceiver({ protocols });

const gatewayMemoryLimiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
const gatewayBatch = new BatchProcessor({ timeout: "5s" });
const gatewayHealth = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

const plaintext = { insecure: true };
const toTempo = new OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: plaintext });
const toLoki = new OtlpHttpExporter({ name: "loki", endpoint: "http://loki:3100/otlp" });

/** Served on each replica; Prometheus finds the replicas through the gateway's headless Service. */
export const METRICS_PORT = 8889;
const scrapeEndpoint = new PrometheusExporter({ endpoint: `0.0.0.0:${METRICS_PORT}`, metric_expiration: "10m" });

export { gatewayOtlp, gatewayMemoryLimiter, gatewayBatch, gatewayHealth, toTempo, toLoki, scrapeEndpoint };
