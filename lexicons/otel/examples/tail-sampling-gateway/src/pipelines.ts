/**
 * The gateway's pipelines: every span to the span metrics and on to
 * sampling, the sampled traces to Tempo, the metrics to Prometheus.
 */
import { Pipeline } from "@intentius/chant-lexicon-otel";
import { otlp, memoryLimiter, batch, spanmetrics, tempo, prometheus } from "./components";
import { toSampling, sampling } from "./sampling";

const traces = new Pipeline({ signal: "traces", receivers: [otlp], processors: [memoryLimiter], exporters: [spanmetrics, toSampling] });

const sampled = new Pipeline({ signal: "traces", name: "sampled", receivers: [toSampling], processors: [sampling, batch], exporters: [tempo] });

const metrics = new Pipeline({ signal: "metrics", receivers: [spanmetrics], processors: [batch], exporters: [prometheus] });

export { traces, sampled, metrics };
