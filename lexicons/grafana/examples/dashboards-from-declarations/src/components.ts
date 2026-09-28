/**
 * The collector's components. Every span becomes RED metrics through a
 * `spanmetrics` connector; GenAI spans also become per-model and per-tool
 * metrics and token sums through the GenAI preset; Prometheus scrapes it all
 * from the `prometheus` exporter, and traces go to Tempo.
 */
import {
  BatchProcessor,
  genAiComponents,
  MemoryLimiterProcessor,
  OtlpExporter,
  OtlpReceiver,
  PrometheusExporter,
  SpanMetricsConnector,
  type OtlpReceiverConfig,
  type SpanMetricsConnectorConfig,
} from "@intentius/chant-lexicon-otel";

const protocols: OtlpReceiverConfig["protocols"] = { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } };
const otlp = new OtlpReceiver({ protocols });

const memoryLimiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
const batch = new BatchProcessor({});

const plaintext = { insecure: true };
const tempoTraces = new OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: plaintext });

const milliseconds: SpanMetricsConnectorConfig["histogram"] = {
  unit: "ms",
  explicit: { buckets: ["5ms", "10ms", "25ms", "50ms", "100ms", "250ms", "500ms", "1s", "2s", "5s"] },
};

/** Rename the namespace and the RED dashboard and the SLO follow. */
const spans = new SpanMetricsConnector({ namespace: "shop", histogram: milliseconds, metrics_flush_interval: "15s" });

/** Served on 8889 for Prometheus to scrape. */
const metricsEndpoint = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });

/** The GenAI preset's pieces, its metric names under `agents`. */
const genai = genAiComponents({ namespace: "agents" });

export { otlp, memoryLimiter, batch, tempoTraces, spans, metricsEndpoint, genai };
