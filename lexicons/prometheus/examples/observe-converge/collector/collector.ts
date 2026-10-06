/**
 * The collector `ops/collector-health.op.ts` observes: OTLP in, batched,
 * debug out, with a `health_check` on 13133 and the collector's own metrics
 * on 8888. `chant build collector --lexicon otel` writes dist/collector.yaml,
 * the file the collector runs and the observer reads its endpoints from.
 */
import {
  BatchProcessor,
  DebugExporter,
  HealthCheckExtension,
  OtlpReceiver,
  Pipeline,
  Service,
} from "@intentius/chant-lexicon-otel";

const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } } });
const batch = new BatchProcessor({ timeout: "5s" });
const debug = new DebugExporter({ verbosity: "basic" });
export const health = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

export const traces = new Pipeline({ signal: "traces", receivers: [otlp], processors: [batch], exporters: [debug] });
export const metrics = new Pipeline({ signal: "metrics", receivers: [otlp], processors: [batch], exporters: [debug] });

export const service = new Service({
  telemetry: { metrics: { level: "basic", readers: [{ pull: { exporter: { prometheus: { host: "0.0.0.0", port: 8888 } } } }] } },
});
