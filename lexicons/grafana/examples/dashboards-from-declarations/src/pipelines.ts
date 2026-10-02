/**
 * The collector's pipelines: traces to Tempo and into both connectors, GenAI
 * spans into the preset's metrics, and every metric out to Prometheus.
 */
import { Pipeline } from "@intentius/chant-lexicon-otel";
import { batch, genai, memoryLimiter, metricsEndpoint, otlp, spans, tempoTraces } from "./components";

// The preset deletes content unless told to keep it, so both processors are there.
const contentRemoval = genai.contentRemoval!;
const redaction = genai.redaction!;

const traces = new Pipeline({
  signal: "traces",
  receivers: [otlp],
  processors: [memoryLimiter, contentRemoval, redaction, batch],
  exporters: [tempoTraces, spans, genai.forward],
});

const genAiTraces = new Pipeline({
  signal: "traces",
  name: "genai",
  receivers: [genai.forward],
  processors: [genai.genAiSpans],
  exporters: [genai.spanMetrics, genai.tokenUsage],
});

const metrics = new Pipeline({
  signal: "metrics",
  receivers: [spans, genai.spanMetrics, genai.tokenUsage],
  processors: [batch],
  exporters: [metricsEndpoint],
});


export { traces, genAiTraces, metrics };
