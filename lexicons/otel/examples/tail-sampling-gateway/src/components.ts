/**
 * A gateway collector: the tier per-node agents send traces to, where whole
 * traces are in one place. Every span first becomes rate, error and duration
 * metrics, so the metrics count all traffic; then the spans go to a second
 * pipeline that keeps errors, slow traces and a tenth of the rest, and sends
 * those to Tempo. This file: receiving, metrics and the exporters.
 */
import {
  OtlpReceiver,
  MemoryLimiterProcessor,
  BatchProcessor,
  SpanMetricsConnector,
  OtlpExporter,
  PrometheusExporter,
  type OtlpReceiverConfig,
  type SpanMetricsConnectorConfig,
  type TLSClientSettings,
} from "@intentius/chant-lexicon-otel";

const protocols: OtlpReceiverConfig["protocols"] = { grpc: { endpoint: "0.0.0.0:4317" } };
const otlp = new OtlpReceiver({ protocols });

const memoryLimiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
const batch = new BatchProcessor({ timeout: "5s" });

// Calls, errors and duration per service, span name and kind, before any span is dropped.
const milliseconds: SpanMetricsConnectorConfig["histogram"] = { unit: "ms" };
const spanmetrics = new SpanMetricsConnector({ histogram: milliseconds, metrics_flush_interval: "15s" });

const plaintext: TLSClientSettings = { insecure: true };
const tempo = new OtlpExporter({ name: "tempo", endpoint: "tempo.observability.svc:4317", tls: plaintext });
const prometheus = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });

export { otlp, memoryLimiter, batch, spanmetrics, tempo, prometheus };
