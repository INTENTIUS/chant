/**
 * The smallest useful collector: OTLP in, batched, OTLP out to a tracing
 * backend, with a debug copy of every log line. `chant build` writes the
 * config `otelcol --config` reads.
 *
 * Nested settings are named consts typed with the lexicon's config types, so
 * each constructor stays flat.
 */
import {
  OtlpReceiver,
  MemoryLimiterProcessor,
  BatchProcessor,
  OtlpExporter,
  DebugExporter,
  HealthCheckExtension,
  Pipeline,
  type OtlpReceiverConfig,
  type TLSClientSettings,
  type QueueSettings,
} from "@intentius/chant-lexicon-otel";

const protocols: OtlpReceiverConfig["protocols"] = {
  grpc: { endpoint: "0.0.0.0:4317" },
  http: { endpoint: "0.0.0.0:4318" },
};

const otlp = new OtlpReceiver({ protocols });

const memoryLimiter = new MemoryLimiterProcessor({
  check_interval: "1s",
  limit_percentage: 80,
  spike_limit_percentage: 20,
});

const batch = new BatchProcessor({ timeout: "5s", send_batch_size: 1024 });

const plaintext: TLSClientSettings = { insecure: true };
const queue: QueueSettings = { enabled: true, queue_size: 5000 };

/** `otlp/tempo`: the instance name leaves room for a second otlp exporter. */
const tempo = new OtlpExporter({
  name: "tempo",
  endpoint: "tempo.observability.svc:4317",
  tls: plaintext,
  sending_queue: queue,
});

const debug = new DebugExporter({ verbosity: "basic" });

const health = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

const traces = new Pipeline({
  signal: "traces",
  receivers: [otlp],
  processors: [memoryLimiter, batch],
  exporters: [tempo],
});

const logs = new Pipeline({
  signal: "logs",
  receivers: [otlp],
  processors: [memoryLimiter, batch],
  exporters: [debug],
});

export { otlp, memoryLimiter, batch, tempo, debug, health, traces, logs };
