/**
 * What the gateway derives from spans, and how it samples them.
 *
 * Every span is counted before anything is dropped: the `spanmetrics`
 * connector turns all of them into RED metrics, and the GenAI preset's
 * connectors turn GenAI spans into per-operation, per-model and per-tool
 * metrics and token sums. Only then does tail sampling thin the traces that
 * go to Tempo: it keeps every trace with an error, every trace slower than
 * two seconds, and a tenth of the rest.
 */
import {
  ForwardConnector,
  SpanMetricsConnector,
  TailSamplingProcessor,
  genAiComponents,
  type SpanMetricsConnectorConfig,
  type TailSamplingPolicy,
} from "@intentius/chant-lexicon-otel";

const milliseconds: SpanMetricsConnectorConfig["histogram"] = {
  unit: "ms",
  explicit: { buckets: ["50ms", "100ms", "250ms", "500ms", "1s", "2s", "5s", "10s"] },
};

/** RED metrics for every service: `traces_span_metrics_calls_total` and the duration histogram. */
const red = new SpanMetricsConnector({ histogram: milliseconds, metrics_flush_interval: "15s" });

/**
 * The GenAI preset's pieces: content removal, and a `traces/genai` branch
 * whose connectors emit `genai_calls_total`, `genai_duration_seconds` and
 * `genai_tokens_{input,output}_total`.
 */
const genai = genAiComponents({ metricsFlushInterval: "15s" });

/** Carries every span, after content removal, to the sampled pipeline. */
const toSampling = new ForwardConnector({ name: "sampled" });

const errors: TailSamplingPolicy = { name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } };
const slow: TailSamplingPolicy = { name: "slow", type: "latency", latency: { threshold_ms: 2000 } };
const baseline: TailSamplingPolicy = { name: "baseline", type: "probabilistic", probabilistic: { sampling_percentage: 10 } };
const policies = [errors, slow, baseline];

const sampling = new TailSamplingProcessor({ decision_wait: "5s", num_traces: 50000, policies });

export { red, genai, toSampling, sampling };
