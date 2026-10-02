/**
 * The gateway: two collector replicas where metrics are derived and traces
 * are sampled.
 *
 * `traces` removes GenAI content and fans every span out three ways: to the
 * RED `spanmetrics` connector, to the GenAI preset's `traces/genai` branch,
 * and to `traces/sampled`, where tail sampling decides what reaches Tempo.
 * Tail sampling and span metrics both need every span of a trace on one
 * replica, which is why the agents route traces by trace id (agent.ts), and
 * why WK8601 and WK8602 have nothing to say about this build.
 */
import { OtelCollectorGateway } from "@intentius/chant-lexicon-k8s";
import { Pipeline } from "@intentius/chant-lexicon-otel";
import {
  gatewayOtlp,
  gatewayMemoryLimiter,
  gatewayBatch,
  gatewayHealth,
  toTempo,
  toLoki,
  scrapeEndpoint,
} from "./gateway-components";
import { red, genai, toSampling, sampling } from "./gateway-metrics";
import { NAMESPACE } from "./namespace";

// The preset deletes content unless told to keep it, so both processors are there.
const contentRemoval = genai.contentRemoval!;
const redaction = genai.redaction!;

const traces = new Pipeline({
  signal: "traces",
  receivers: [gatewayOtlp],
  processors: [gatewayMemoryLimiter, contentRemoval, redaction],
  exporters: [red, genai.forward, toSampling],
});

const sampled = new Pipeline({
  signal: "traces",
  name: "sampled",
  receivers: [toSampling],
  processors: [sampling, gatewayBatch],
  exporters: [toTempo],
});

const genAiSpans = new Pipeline({
  signal: "traces",
  name: "genai",
  receivers: [genai.forward],
  processors: [genai.genAiSpans],
  exporters: [genai.spanMetrics, genai.tokenUsage],
});

const metrics = new Pipeline({
  signal: "metrics",
  receivers: [gatewayOtlp, red, genai.spanMetrics, genai.tokenUsage],
  processors: [gatewayMemoryLimiter, gatewayBatch],
  exporters: [scrapeEndpoint],
});

const logs = new Pipeline({
  signal: "logs",
  receivers: [gatewayOtlp],
  processors: [gatewayMemoryLimiter, contentRemoval, redaction, gatewayBatch],
  exporters: [toLoki],
});

export const gateway = OtelCollectorGateway({
  name: "otel-gateway",
  namespace: NAMESPACE,
  replicas: 2,
  config: [gatewayHealth, traces, sampled, genAiSpans, metrics, logs],
});
