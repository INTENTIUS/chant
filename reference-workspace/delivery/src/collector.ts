import {
  BatchProcessor,
  MemoryLimiterProcessor,
  OtlpHttpExporter,
  OtlpReceiver,
  type OtlpReceiverConfig,
  Pipeline,
} from "@intentius/chant-lexicon-otel";

/**
 * Where the app's telemetry goes (#2559). The app sends OTLP to this
 * collector, and the collector forwards traces to a backend. `chant workspace
 * graph` lists the pipeline and the exporter's endpoint in `collectors`, read
 * from this member's own build, so a reader knows where the app's spans end up
 * without opening the collector YAML.
 */
const protocols: OtlpReceiverConfig["protocols"] = { http: { endpoint: "0.0.0.0:4318" } };
const otlp = new OtlpReceiver({ protocols });
const memory = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
const batch = new BatchProcessor({ timeout: "5s" });
const backend = new OtlpHttpExporter({ name: "backend", endpoint: "https://telemetry.example.com:4318" });

export const traces = new Pipeline({
  signal: "traces",
  receivers: [otlp],
  processors: [memory, batch],
  exporters: [backend],
});
