/**
 * A collector preset for workloads that emit OpenTelemetry GenAI spans:
 * content removal, and agent RED and token metrics.
 *
 * Attribute keys follow `GENAI_SEMCONV_PIN`. Content (prompts, completions,
 * system instructions, tool-call arguments and results, retrieval queries and
 * documents) is deleted from spans, span events and log records unless the
 * caller passes `keepContent: true`. A `transform` processor deletes the keys;
 * `redaction` cannot delete one named key while keeping the rest, so it runs
 * after the transform as a masking backstop on the same keys and for any
 * value patterns the caller adds.
 *
 * Metrics come from a branch taken before any sampling: the traces pipeline
 * forwards every span to `traces/genai`, which keeps only spans with a
 * `gen_ai.operation.name`, and feeds `spanmetrics` (calls, errors and
 * duration by operation, model, tool and error type) and `sum` (input and
 * output tokens by model). `spanmetrics` counts spans and
 * cannot sum an attribute, which is why token usage comes from the `sum`
 * connector.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { GENAI_SEMCONV_PIN, type OTelComponent, type SchemaPin } from "./define";
import { OtlpReceiver } from "./components/receivers";
import { BatchProcessor, MemoryLimiterProcessor } from "./components/processors";
import { DebugExporter } from "./components/exporters";
import { HealthCheckExtension } from "./components/extensions";
import {
  FilterProcessor,
  RedactionProcessor,
  TransformProcessor,
  type FilterProcessorConfig,
  type RedactionProcessorConfig,
  type TransformProcessorConfig,
  type TransformStatementGroup,
} from "./components/filtering";
import {
  ForwardConnector,
  SpanMetricsConnector,
  SumConnector,
  type ForwardConnectorConfig,
  type SpanMetricsConnectorConfig,
  type SpanMetricsDimension,
  type SumConnectorConfig,
} from "./components/connectors";
import type { Duration } from "./components/common";
import { Pipeline } from "./pipeline";

// ── The GenAI attribute vocabulary, at GENAI_SEMCONV_PIN ─────────────

/** GenAI attributes the preset reads. */
export const GENAI_ATTRIBUTES = Object.freeze({
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  agentName: "gen_ai.agent.name",
  toolName: "gen_ai.tool.name",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  /** From the general conventions; GenAI spans set it on failure. */
  errorType: "error.type",
} as const);

/**
 * Attributes that carry content: what users and models said, and what tools
 * were given and returned. The conventions mark each opt-in and sensitive.
 * `gen_ai.prompt` and `gen_ai.completion` are deprecated, but older
 * instrumentation still sets them.
 */
export const GENAI_CONTENT_ATTRIBUTES: readonly string[] = Object.freeze([
  "gen_ai.system_instructions",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.retrieval.query.text",
  "gen_ai.retrieval.documents",
  "gen_ai.prompt",
  "gen_ai.completion",
]);

/**
 * Indexed content keys some instrumentation libraries write outside the
 * conventions (`gen_ai.prompt.0.content`, `gen_ai.completion.1.role`). The
 * index keeps `gen_ai.prompt.name`, a convention attribute, out of it.
 */
export const GENAI_INDEXED_CONTENT_PATTERN = "^gen_ai\\.(prompt|completion)\\.[0-9]+\\..+$";

/**
 * Deprecated content events. Their content is in the log record body, not in
 * attributes, so the preset deletes `content`, `message` and `tool_calls`
 * from the body of these events.
 */
export const GENAI_CONTENT_EVENTS: readonly string[] = Object.freeze([
  "gen_ai.system.message",
  "gen_ai.user.message",
  "gen_ai.assistant.message",
  "gen_ai.tool.message",
  "gen_ai.choice",
]);

// ── Metrics ──────────────────────────────────────────────────────────

/** The spanmetrics dimensions the preset adds to service.name, span.name, span.kind and status.code. */
export const GENAI_SPAN_METRIC_DIMENSIONS: readonly string[] = Object.freeze([
  GENAI_ATTRIBUTES.operationName,
  GENAI_ATTRIBUTES.requestModel,
  GENAI_ATTRIBUTES.toolName,
  GENAI_ATTRIBUTES.errorType,
]);

/**
 * The attribute token sums are split by. One only: the pinned `sum`
 * connector adds each value once per attribute, so a second one would double
 * every sum.
 */
export const GENAI_TOKEN_DIMENSIONS: readonly string[] = Object.freeze([GENAI_ATTRIBUTES.requestModel]);

/** The model label on token sums for a span that names no model, so its tokens are counted rather than skipped. */
export const GENAI_UNKNOWN_MODEL = "unknown";

/** Default duration buckets, sized for model and tool calls rather than HTTP handlers. */
export const GENAI_DURATION_BUCKETS: readonly Duration[] = Object.freeze([
  "100ms",
  "250ms",
  "500ms",
  "1s",
  "2s",
  "5s",
  "10s",
  "20s",
  "40s",
  "80s",
]);

/** One metric the preset emits, as the collector names it and as Prometheus exposes it. */
export interface GenAiMetric {
  /** The OTLP metric name. */
  name: string;
  /** The name the `prometheus` exporter serves with its default suffixes; histograms add `_bucket`, `_sum` and `_count`. */
  prometheus: string;
  type: "sum" | "histogram";
  unit?: string;
  /** Attribute names on its data points, beyond the resource. Prometheus labels replace `.` with `_`. */
  dimensions: string[];
}

export interface GenAiMetrics {
  /** Span count, with `status.code` = `STATUS_CODE_ERROR` for errors. */
  calls: GenAiMetric;
  duration: GenAiMetric;
  inputTokens: GenAiMetric;
  outputTokens: GenAiMetric;
}

export interface GenAiMetricsOptions {
  /** Prefix of the emitted metric names. Default `genai`, outside the conventions' own `gen_ai` namespace. */
  namespace?: string;
  /** Dimensions added to the span metrics beyond the GenAI ones. */
  dimensions?: SpanMetricsDimension[];
}

const DEFAULT_NAMESPACE = "genai";
const SPANMETRICS_DEFAULT_DIMENSIONS = ["service.name", "span.name", "span.kind", "status.code"];

function prometheusName(name: string, suffix: string): string {
  return `${name.replace(/[^A-Za-z0-9_:]/g, "_")}${suffix}`;
}

/**
 * The metrics `genAiPipeline()` emits for the given options: names,
 * Prometheus names and dimensions. A dashboard reads this instead of
 * repeating the names, so renaming the namespace moves the panels with it.
 */
export function genAiMetrics(options: GenAiMetricsOptions = {}): GenAiMetrics {
  const ns = options.namespace ?? DEFAULT_NAMESPACE;
  const spanDims = [
    ...SPANMETRICS_DEFAULT_DIMENSIONS,
    ...GENAI_SPAN_METRIC_DIMENSIONS,
    ...(options.dimensions ?? []).map((d) => d.name),
  ];
  const tokenDims = [...GENAI_TOKEN_DIMENSIONS];
  return {
    calls: { name: `${ns}.calls`, prometheus: prometheusName(`${ns}.calls`, "_total"), type: "sum", dimensions: spanDims },
    duration: {
      name: `${ns}.duration`,
      prometheus: prometheusName(`${ns}.duration`, "_seconds"),
      type: "histogram",
      unit: "s",
      dimensions: spanDims,
    },
    inputTokens: {
      name: `${ns}.tokens.input`,
      prometheus: prometheusName(`${ns}.tokens.input`, "_total"),
      type: "sum",
      dimensions: tokenDims,
    },
    outputTokens: {
      name: `${ns}.tokens.output`,
      prometheus: prometheusName(`${ns}.tokens.output`, "_total"),
      type: "sum",
      dimensions: tokenDims,
    },
  };
}

// ── Components ───────────────────────────────────────────────────────

type Exporter = OTelComponent<"exporter", string, any>;
type Processor = OTelComponent<"processor", string, any>;

export interface GenAiComponentsOptions extends GenAiMetricsOptions {
  /**
   * Keep content attributes and bodies. Default false: they are deleted.
   * Setting this is the one way to keep prompts and completions, so a config
   * that keeps them says so where it is declared.
   */
  keepContent?: boolean;
  /** More attribute keys that hold content, deleted along with the convention ones. */
  contentAttributes?: string[];
  /** RE2 patterns masked in every attribute value (redaction `blocked_values`), whether content is kept or not. */
  maskValues?: string[];
  /** Hash masked values with this function instead of writing `****`. */
  hashFunction?: RedactionProcessorConfig["hash_function"];
  /** Duration histogram buckets. Default `GENAI_DURATION_BUCKETS`. */
  buckets?: Duration[];
  /** How often span and token metrics are flushed. Default 15s. */
  metricsFlushInterval?: Duration;
}

export interface GenAiComponents {
  /** Deletes content keys and event bodies (`transform/genai_content`). Absent when content is kept. */
  contentRemoval?: OTelComponent<"processor", "transform", TransformProcessorConfig>;
  /**
   * Masks what is left (`redaction/genai_content`): the content keys, as a
   * backstop behind the transform, and `maskValues`. Absent when content is
   * kept and nothing is masked.
   */
  redaction?: OTelComponent<"processor", "redaction", RedactionProcessorConfig>;
  /** Content removal then redaction, in the order a pipeline should run them. */
  processors: Processor[];
  /** Carries every span from the traces pipeline to `traces/genai` (`forward/genai`). */
  forward: OTelComponent<"connector", "forward", ForwardConnectorConfig>;
  /** Keeps only GenAI spans in `traces/genai` (`filter/genai_spans`). */
  genAiSpans: OTelComponent<"processor", "filter", FilterProcessorConfig>;
  /** Calls, errors and duration per GenAI dimension (`spanmetrics/genai`). */
  spanMetrics: OTelComponent<"connector", "spanmetrics", SpanMetricsConnectorConfig>;
  /** Input and output token sums (`sum/genai_tokens`). */
  tokenUsage: OTelComponent<"connector", "sum", SumConnectorConfig>;
  metrics: GenAiMetrics;
  /** The semantic conventions the attribute keys follow. */
  semconv: SchemaPin;
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function escapeRe2(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/** OTTL that deletes the content keys from one context's attributes. */
function deleteStatements(target: string, keys: string[]): string[] {
  return [
    ...keys.map((k) => `delete_key(${target}, ${quote(k)})`),
    `delete_matching_keys(${target}, ${quote(GENAI_INDEXED_CONTENT_PATTERN)})`,
  ];
}

/** The pieces of the GenAI preset, for wiring into pipelines you declare yourself. */
export function genAiComponents(options: GenAiComponentsOptions = {}): GenAiComponents {
  const keepContent = options.keepContent === true;
  const contentKeys = [...GENAI_CONTENT_ATTRIBUTES, ...(options.contentAttributes ?? [])];
  const metrics = genAiMetrics(options);

  let contentRemoval: GenAiComponents["contentRemoval"];
  if (!keepContent) {
    // Older SDKs name the event in an `event.name` attribute instead of the record's event_name.
    const events = quote(`^(${GENAI_CONTENT_EVENTS.map(escapeRe2).join("|")})$`);
    const eventMatch = `IsMatch(log.event_name, ${events}) or IsMatch(log.attributes["event.name"], ${events})`;
    const traceGroups: TransformStatementGroup<"span" | "spanevent">[] = [
      { context: "span", statements: deleteStatements("span.attributes", contentKeys) },
      { context: "spanevent", statements: deleteStatements("spanevent.attributes", contentKeys) },
    ];
    const logGroups: TransformStatementGroup<"log">[] = [
      {
        context: "log",
        statements: [
          ...deleteStatements("log.attributes", contentKeys),
          `delete_matching_keys(log.body, "^(content|message|tool_calls)$") where IsMap(log.body) and (${eventMatch})`,
          `set(log.body, "") where IsString(log.body) and (${eventMatch})`,
        ],
      },
    ];
    contentRemoval = new TransformProcessor({
      name: "genai_content",
      error_mode: "ignore",
      trace_statements: traceGroups,
      log_statements: logGroups,
    });
  }

  const blockedKeys = keepContent
    ? []
    : [`^(${contentKeys.map(escapeRe2).join("|")})$`, GENAI_INDEXED_CONTENT_PATTERN];
  const maskValues = options.maskValues ?? [];
  let redaction: GenAiComponents["redaction"];
  if (blockedKeys.length > 0 || maskValues.length > 0) {
    redaction = new RedactionProcessor({
      name: "genai_content",
      allow_all_keys: true,
      ...(blockedKeys.length > 0 ? { blocked_key_patterns: blockedKeys } : {}),
      ...(maskValues.length > 0 ? { blocked_values: maskValues } : {}),
      ...(options.hashFunction ? { hash_function: options.hashFunction } : {}),
    });
  }

  const forward = new ForwardConnector({ name: "genai" });
  const genAiSpans = new FilterProcessor({
    name: "genai_spans",
    error_mode: "ignore",
    traces: { span: [`attributes[${quote(GENAI_ATTRIBUTES.operationName)}] == nil`] },
  });

  const flush = options.metricsFlushInterval ?? "15s";
  const spanMetrics = new SpanMetricsConnector({
    name: "genai",
    namespace: options.namespace ?? DEFAULT_NAMESPACE,
    dimensions: [...GENAI_SPAN_METRIC_DIMENSIONS.map((name) => ({ name })), ...(options.dimensions ?? [])],
    histogram: { unit: "s", explicit: { buckets: [...(options.buckets ?? GENAI_DURATION_BUCKETS)] } },
    metrics_flush_interval: flush,
  });

  // An in-process invoke_agent or invoke_workflow span may carry the usage of
  // the model calls under it, which are counted on their own spans.
  const notAggregate = `not (kind == SPAN_KIND_INTERNAL and (attributes[${quote(GENAI_ATTRIBUTES.operationName)}] == "invoke_agent" or attributes[${quote(GENAI_ATTRIBUTES.operationName)}] == "invoke_workflow"))`;
  const tokenAttributes = GENAI_TOKEN_DIMENSIONS.map((key) => ({ key, default_value: GENAI_UNKNOWN_MODEL }));
  const tokenUsage = new SumConnector({
    name: "genai_tokens",
    spans: {
      [metrics.inputTokens.name]: {
        source_attribute: GENAI_ATTRIBUTES.inputTokens,
        description: "Input tokens used by GenAI operations",
        conditions: [`attributes[${quote(GENAI_ATTRIBUTES.inputTokens)}] != nil and ${notAggregate}`],
        attributes: tokenAttributes,
      },
      [metrics.outputTokens.name]: {
        source_attribute: GENAI_ATTRIBUTES.outputTokens,
        description: "Output tokens used by GenAI operations",
        conditions: [`attributes[${quote(GENAI_ATTRIBUTES.outputTokens)}] != nil and ${notAggregate}`],
        attributes: tokenAttributes,
      },
    },
  });

  const processors: Processor[] = [];
  if (contentRemoval) processors.push(contentRemoval);
  if (redaction) processors.push(redaction);

  return {
    ...(contentRemoval ? { contentRemoval } : {}),
    ...(redaction ? { redaction } : {}),
    processors,
    forward,
    genAiSpans,
    spanMetrics,
    tokenUsage,
    metrics,
    semconv: GENAI_SEMCONV_PIN,
  };
}

// ── The whole collector ──────────────────────────────────────────────

export interface GenAiPipelineOptions extends GenAiComponentsOptions {
  /** Where traces go. Default: one `debug` exporter at `basic` verbosity. */
  traceExporters?: Exporter[];
  /** Where the span and token metrics go. Default: the same `debug` exporter. */
  metricExporters?: Exporter[];
  /** Where logs (and events sent as logs) go. Default: the same `debug` exporter. */
  logExporters?: Exporter[];
  /** Give logs a pipeline, so event-based content is removed too. Default: true. */
  logs?: boolean;
  /**
   * Processors that thin exported traces, such as `tail_sampling`. They run
   * in a `traces/sampled` pipeline after the metrics branch, so metrics still
   * count every span.
   */
  sampling?: Processor[];
  /** Serve `health_check` on 0.0.0.0:13133. Default: true. */
  healthCheck?: boolean;
}

/**
 * The entities of an OTLP collector for GenAI workloads: an `otlp` receiver
 * on 4317 and 4318; `memory_limiter`, content removal and `batch` on traces
 * and logs; a `traces/genai` branch that turns GenAI spans into metrics
 * before any sampling; and a `metrics/genai` pipeline that exports them. Pass
 * the result to `collectorYaml`, or use `genAiComponents()` to wire the
 * pieces into pipelines of your own.
 */
export function genAiPipeline(options: GenAiPipelineOptions = {}): Declarable[] {
  const debug = new DebugExporter({ verbosity: "basic" });
  const { traceExporters = [debug], metricExporters = [debug], logExporters = [debug], logs = true, sampling = [], healthCheck = true } =
    options;
  const parts = genAiComponents(options);

  const otlp = new OtlpReceiver({
    protocols: {
      grpc: { endpoint: "0.0.0.0:4317" },
      http: { endpoint: "0.0.0.0:4318" },
    },
  });
  const memoryLimiter = new MemoryLimiterProcessor({
    check_interval: "1s",
    limit_percentage: 80,
    spike_limit_percentage: 20,
  });
  const batch = new BatchProcessor({});
  const entities: Declarable[] = [otlp];

  if (sampling.length === 0) {
    entities.push(
      new Pipeline({
        signal: "traces",
        receivers: [otlp],
        processors: [memoryLimiter, ...parts.processors, batch],
        exporters: [...traceExporters, parts.forward],
      }),
    );
  } else {
    const sampled = new ForwardConnector({ name: "sampled" });
    entities.push(
      new Pipeline({
        signal: "traces",
        receivers: [otlp],
        processors: [memoryLimiter, ...parts.processors],
        exporters: [parts.forward, sampled],
      }),
      new Pipeline({
        signal: "traces",
        name: "sampled",
        receivers: [sampled],
        processors: [...sampling, batch],
        exporters: traceExporters,
      }),
    );
  }
  entities.push(
    new Pipeline({
      signal: "traces",
      name: "genai",
      receivers: [parts.forward],
      processors: [parts.genAiSpans],
      exporters: [parts.spanMetrics, parts.tokenUsage],
    }),
    new Pipeline({
      signal: "metrics",
      name: "genai",
      receivers: [parts.spanMetrics, parts.tokenUsage],
      processors: [batch],
      exporters: metricExporters,
    }),
  );
  if (logs) {
    entities.push(
      new Pipeline({
        signal: "logs",
        receivers: [otlp],
        processors: [memoryLimiter, ...parts.processors, batch],
        exporters: logExporters,
      }),
    );
  }
  if (healthCheck) entities.push(new HealthCheckExtension({ endpoint: "0.0.0.0:13133" }));
  return entities;
}
