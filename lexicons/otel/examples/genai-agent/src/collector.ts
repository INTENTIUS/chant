/**
 * A collector for an agent service instrumented with the OpenTelemetry GenAI
 * conventions. Prompts, completions and tool payloads are removed before
 * anything leaves the collector; every GenAI span also becomes call, error,
 * duration and token metrics for Prometheus to scrape; and traces go to Tempo.
 */
import { genAiPipeline, OtlpExporter, PrometheusExporter, type TLSClientSettings } from "@intentius/chant-lexicon-otel";

const plaintext: TLSClientSettings = { insecure: true };

const tempo = new OtlpExporter({ name: "tempo", endpoint: "tempo.observability:4317", tls: plaintext });

const prometheus = new PrometheusExporter({ endpoint: "0.0.0.0:8889" });

/** Content stays out unless `keepContent: true` is set here. Card-number-like values are masked in whatever is left. */
export const collector = genAiPipeline({
  traceExporters: [tempo],
  metricExporters: [prometheus],
  maskValues: ["\\b[0-9]{13,16}\\b"],
  logs: false,
});
