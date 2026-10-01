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
 *
 * With `clientMetrics: "derive"`, a `signaltometrics` connector on the same
 * branch also emits the two client metrics the conventions define at the pin,
 * `gen_ai.client.operation.duration` and `gen_ai.client.token.usage`, under
 * their own names, attributes, units and buckets. `clientMetrics:
 * "passthrough"` derives nothing and relies on the SDK to send them. Either
 * way a `metrics` pipeline passes the SDK's OTLP metrics through. Without the
 * option the output is what it was before the option existed.
 *
 * `sum` emits delta sums. The `prometheus` exporter accumulates them itself,
 * but `prometheusremotewrite` drops them, and some OTLP backends store only
 * cumulative data; `signaltometrics` emits delta histograms too.
 * `deltaToCumulative` puts a `deltatocumulative` processor on `metrics/genai`
 * for those. It is on by default only with `clientMetrics: "derive"`, so a
 * config built without either option is unchanged.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { GENAI_SEMCONV_PIN, type OTelComponent, type SchemaPin } from "./define";
import { OtlpReceiver } from "./components/receivers";
import { BatchProcessor, DeltaToCumulativeProcessor, MemoryLimiterProcessor } from "./components/processors";
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
  SignalToMetricsConnector,
  SpanMetricsConnector,
  SumConnector,
  type ForwardConnectorConfig,
  type SignalToMetricsAttribute,
  type SignalToMetricsConnectorConfig,
  type SignalToMetricsMetric,
  type SpanMetricsConnectorConfig,
  type SpanMetricsDimension,
  type SumConnectorConfig,
} from "./components/connectors";
import type { Duration } from "./components/common";
import { Pipeline } from "./pipeline";
import { prometheusMetricName, SPANMETRICS_DEFAULT_DIMENSIONS, type CollectorMetric } from "./metric-names";

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
  /** A metric attribute only: `input` or `output` on `gen_ai.client.token.usage`. */
  tokenType: "gen_ai.token.type",
  /** From the general conventions: the GenAI server's host and port. */
  serverAddress: "server.address",
  serverPort: "server.port",
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

/**
 * Dimensions `providerDimensions: true` adds to `genai.calls` and
 * `genai.duration`. The token sums keep the model alone (see
 * `GENAI_TOKEN_DIMENSIONS`); `gen_ai.client.token.usage` splits tokens by both.
 */
export const GENAI_PROVIDER_DIMENSIONS: readonly string[] = Object.freeze([
  GENAI_ATTRIBUTES.providerName,
  GENAI_ATTRIBUTES.responseModel,
]);

// ── The conventions' client metrics, at GENAI_SEMCONV_PIN ────────────

/** The client metrics the conventions define that one span carries enough to derive. */
export const GENAI_CLIENT_METRIC_NAMES = Object.freeze({
  operationDuration: "gen_ai.client.operation.duration",
  tokenUsage: "gen_ai.client.token.usage",
} as const);

/** The values of `gen_ai.token.type` on `gen_ai.client.token.usage`. */
export const GENAI_TOKEN_TYPES = Object.freeze({ input: "input", output: "output" } as const);

/**
 * The attributes the conventions give both client metrics: required
 * (`gen_ai.operation.name`, `gen_ai.provider.name`), conditionally required
 * (`gen_ai.request.model`, `error.type`) and recommended
 * (`gen_ai.response.model`, `server.address`, `server.port`).
 * `gen_ai.client.token.usage` adds `gen_ai.token.type`.
 */
export const GENAI_CLIENT_METRIC_ATTRIBUTES: readonly string[] = Object.freeze([
  GENAI_ATTRIBUTES.operationName,
  GENAI_ATTRIBUTES.providerName,
  GENAI_ATTRIBUTES.requestModel,
  GENAI_ATTRIBUTES.responseModel,
  GENAI_ATTRIBUTES.serverAddress,
  GENAI_ATTRIBUTES.serverPort,
  GENAI_ATTRIBUTES.errorType,
]);

/** The bucket boundaries the conventions advise for `gen_ai.client.operation.duration`, in seconds. */
export const GENAI_CLIENT_DURATION_BUCKETS: readonly number[] = Object.freeze([
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
]);

/** The bucket boundaries the conventions advise for `gen_ai.client.token.usage`, in tokens. */
export const GENAI_CLIENT_TOKEN_BUCKETS: readonly number[] = Object.freeze([
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
]);

/**
 * Where the conventions' client metrics come from. `derive`: the collector
 * builds them from spans. `passthrough`: the SDK already sends them, so the
 * collector passes them on and derives nothing, since both would double
 * every series.
 */
export type GenAiClientMetricsSource = "derive" | "passthrough";

/** One metric the preset emits, as the collector names it and as Prometheus exposes it. */
export type GenAiMetric = CollectorMetric;

/** The conventions' client metrics, under their own names. */
export interface GenAiClientMetrics {
  source: GenAiClientMetricsSource;
  /** `gen_ai.client.operation.duration`, a histogram in seconds. Its `_count` is the operation count. */
  operationDuration: GenAiMetric;
  /** `gen_ai.client.token.usage`, a histogram in tokens; select `gen_ai_token_type` `input` or `output`. */
  tokenUsage: GenAiMetric;
}

export interface GenAiMetrics {
  /** Span count, with `status.code` = `STATUS_CODE_ERROR` for errors. */
  calls: GenAiMetric;
  duration: GenAiMetric;
  inputTokens: GenAiMetric;
  outputTokens: GenAiMetric;
  /** The conventions' client metrics. Present only when `clientMetrics` is set. */
  client?: GenAiClientMetrics;
}

export interface GenAiMetricsOptions {
  /** Prefix of the emitted metric names. Default `genai`, outside the conventions' own `gen_ai` namespace. */
  namespace?: string;
  /** Dimensions added to the span metrics beyond the GenAI ones. */
  dimensions?: SpanMetricsDimension[];
  /** Add `gen_ai.provider.name` and `gen_ai.response.model` to `genai.calls` and `genai.duration`. Default false. */
  providerDimensions?: boolean;
  /**
   * Also produce the conventions' client metrics, `gen_ai.client.operation.duration`
   * and `gen_ai.client.token.usage`. `derive` builds them from spans;
   * `passthrough` expects the SDK to send them. Either adds a `metrics`
   * pipeline that passes the SDK's OTLP metrics through. Unset (the default)
   * leaves the output as it was. The `genai.*` metrics are emitted either way.
   */
  clientMetrics?: GenAiClientMetricsSource;
}

const DEFAULT_NAMESPACE = "genai";

/**
 * The metrics `genAiPipeline()` emits for the given options: names,
 * Prometheus names and dimensions. A dashboard reads this instead of
 * repeating the names, so renaming the namespace moves the panels with it.
 */
export function genAiMetrics(options: GenAiMetricsOptions = {}): GenAiMetrics {
  const ns = options.namespace ?? DEFAULT_NAMESPACE;
  const spanDims = [
    ...SPANMETRICS_DEFAULT_DIMENSIONS,
    ...spanMetricDimensions(options).map((d) => d.name),
  ];
  const tokenDims = [...GENAI_TOKEN_DIMENSIONS];
  const source = clientMetricsSource(options);
  return {
    calls: { name: `${ns}.calls`, prometheus: prometheusMetricName(`${ns}.calls`, "sum"), type: "sum", dimensions: spanDims },
    duration: {
      name: `${ns}.duration`,
      prometheus: prometheusMetricName(`${ns}.duration`, "histogram", "s"),
      type: "histogram",
      unit: "s",
      dimensions: spanDims,
    },
    inputTokens: {
      name: `${ns}.tokens.input`,
      prometheus: prometheusMetricName(`${ns}.tokens.input`, "sum"),
      type: "sum",
      dimensions: tokenDims,
    },
    outputTokens: {
      name: `${ns}.tokens.output`,
      prometheus: prometheusMetricName(`${ns}.tokens.output`, "sum"),
      type: "sum",
      dimensions: tokenDims,
    },
    ...(source ? { client: clientMetrics(source) } : {}),
  };
}

function clientMetricsSource(options: GenAiMetricsOptions): GenAiClientMetricsSource | undefined {
  const source = options.clientMetrics;
  if (source === undefined) return undefined;
  if (source !== "derive" && source !== "passthrough") {
    throw new Error(`genAi: clientMetrics must be "derive" or "passthrough", got ${JSON.stringify(source)}`);
  }
  return source;
}

function clientMetrics(source: GenAiClientMetricsSource): GenAiClientMetrics {
  const { operationDuration, tokenUsage } = GENAI_CLIENT_METRIC_NAMES;
  return {
    source,
    operationDuration: {
      name: operationDuration,
      prometheus: prometheusMetricName(operationDuration, "histogram", "s"),
      type: "histogram",
      unit: "s",
      dimensions: [...GENAI_CLIENT_METRIC_ATTRIBUTES],
    },
    tokenUsage: {
      name: tokenUsage,
      prometheus: prometheusMetricName(tokenUsage, "histogram", "{token}"),
      type: "histogram",
      unit: "{token}",
      dimensions: [...GENAI_CLIENT_METRIC_ATTRIBUTES, GENAI_ATTRIBUTES.tokenType],
    },
  };
}

/** The spanmetrics dimensions beyond the connector's defaults, in config order. */
function spanMetricDimensions(options: GenAiMetricsOptions): SpanMetricsDimension[] {
  return [
    ...GENAI_SPAN_METRIC_DIMENSIONS.map((name) => ({ name })),
    ...(options.providerDimensions ? GENAI_PROVIDER_DIMENSIONS.map((name) => ({ name })) : []),
    ...(options.dimensions ?? []),
  ];
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
  /**
   * `gen_ai.client.operation.duration` and `gen_ai.client.token.usage` from
   * spans (`signaltometrics/genai_client`). Present with `clientMetrics: "derive"`;
   * wire it like `spanMetrics`.
   */
  clientMetrics?: OTelComponent<"connector", "signaltometrics", SignalToMetricsConnectorConfig>;
  /**
   * Drops the SDK's own copies of the derived client metrics from metrics
   * passed through from the SDK (`filter/genai_sdk_client`), so each series
   * is counted once. Present with `clientMetrics: "derive"`; put it on the
   * pipeline that receives the SDK's OTLP metrics.
   */
  sdkClientMetricsFilter?: OTelComponent<"processor", "filter", FilterProcessorConfig>;
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
    dimensions: spanMetricDimensions(options),
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

  let clientMetricsConnector: GenAiComponents["clientMetrics"];
  let sdkClientMetricsFilter: GenAiComponents["sdkClientMetricsFilter"];
  if (metrics.client?.source === "derive") {
    clientMetricsConnector = deriveClientMetrics(metrics.client, notAggregate);
    const names = [metrics.client.operationDuration.name, metrics.client.tokenUsage.name];
    sdkClientMetricsFilter = new FilterProcessor({
      name: "genai_sdk_client",
      error_mode: "ignore",
      metrics: { metric: names.map((n) => `name == ${quote(n)}`) },
    });
  }

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
    ...(clientMetricsConnector ? { clientMetrics: clientMetricsConnector } : {}),
    ...(sdkClientMetricsFilter ? { sdkClientMetricsFilter } : {}),
    metrics,
    semconv: GENAI_SEMCONV_PIN,
  };
}

/**
 * The `signaltometrics` connector for the conventions' client metrics. Every
 * GenAI span records its duration. Token usage is one histogram fed by two
 * entries, input and output, each setting `gen_ai.token.type` through the
 * attribute's `default_value` (spans don't carry that key); the connector
 * merges entries with the same name, unit and description into one metric.
 * Token entries skip the in-process agent and workflow spans the `sum`
 * connector skips, and spans whose count is not a number, which would
 * otherwise fail the batch.
 */
function deriveClientMetrics(client: GenAiClientMetrics, notAggregate: string) {
  const [operation, ...rest] = GENAI_CLIENT_METRIC_ATTRIBUTES;
  // Spans always have the operation (filter/genai_spans keeps no other); the
  // rest are optional, so a span that lacks one, such as a tool call without
  // a provider, is still counted.
  const attributes: SignalToMetricsAttribute[] = [{ key: operation! }, ...rest.map((key) => ({ key, optional: true }))];
  const duration: SignalToMetricsMetric = {
    name: client.operationDuration.name,
    description: "GenAI operation duration.",
    unit: client.operationDuration.unit!,
    attributes,
    histogram: {
      buckets: [...GENAI_CLIENT_DURATION_BUCKETS],
      value: "Double(Microseconds(end_time - start_time)) / 1000000.0",
    },
  };
  const tokens = (tokenType: string, source: string): SignalToMetricsMetric => {
    const attr = `attributes[${quote(source)}]`;
    return {
      name: client.tokenUsage.name,
      description: "Number of input and output tokens used.",
      unit: client.tokenUsage.unit!,
      attributes: [...attributes, { key: GENAI_ATTRIBUTES.tokenType, default_value: tokenType }],
      conditions: [`(IsInt(${attr}) or IsDouble(${attr})) and ${notAggregate}`],
      histogram: { buckets: [...GENAI_CLIENT_TOKEN_BUCKETS], value: attr },
    };
  };
  return new SignalToMetricsConnector({
    name: "genai_client",
    spans: [
      duration,
      tokens(GENAI_TOKEN_TYPES.input, GENAI_ATTRIBUTES.inputTokens),
      tokens(GENAI_TOKEN_TYPES.output, GENAI_ATTRIBUTES.outputTokens),
    ],
  });
}

// ── The whole collector ──────────────────────────────────────────────

/**
 * Metric exporters that take delta sums and histograms as they are: the
 * `prometheus` exporter accumulates them itself, and `debug` prints them.
 * Any other exporter gets cumulative data under `deltaToCumulative: "auto"`.
 * `prometheusremotewrite`, for one, drops non-cumulative monotonic sums,
 * histograms and summaries (its README at collector-contrib v0.130.0).
 */
export const DELTA_READY_EXPORTERS: readonly string[] = Object.freeze(["prometheus", "debug"]);

/** Whether `deltaToCumulative` puts a `deltatocumulative` processor on `metrics/genai` for these exporters. */
export function genAiNeedsDeltaToCumulative(
  setting: GenAiPipelineOptions["deltaToCumulative"],
  metricExporters: readonly Exporter[],
): boolean {
  if (setting === true) return true;
  if (setting === "auto") return metricExporters.some((e) => !DELTA_READY_EXPORTERS.includes(e.componentType));
  if (setting === undefined || setting === false) return false;
  throw new Error(`genAiPipeline: deltaToCumulative must be true, false or "auto", got ${JSON.stringify(setting)}`);
}

export interface GenAiPipelineOptions extends GenAiComponentsOptions {
  /** Where traces go. Default: one `debug` exporter at `basic` verbosity. */
  traceExporters?: Exporter[];
  /**
   * Where the span and token metrics go, and with `clientMetrics` the SDK's
   * metrics too. Default: the same `debug` exporter. See `deltaToCumulative`
   * for exporters that need cumulative data.
   */
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
  /**
   * Put a `deltatocumulative/genai` processor in front of `batch` on
   * `metrics/genai`, so the delta token sums of the `sum` connector, and with
   * `clientMetrics: "derive"` the delta histograms of `signaltometrics`, reach
   * exporters as cumulative data. The span metrics are cumulative already and
   * pass through unchanged. `"auto"`: when a metric exporter is not in
   * `DELTA_READY_EXPORTERS` (`prometheus`, `debug`), such as
   * `prometheusremotewrite` or `otlp`. `true`: always. `false`: never, such
   * as for an OTLP backend that wants deltas. Unset: `"auto"` with
   * `clientMetrics: "derive"`, otherwise `false`, which is the output from
   * before the option existed. The processor keeps running totals in memory,
   * so a collector behind a load balancer needs each stream to reach one
   * replica.
   */
  deltaToCumulative?: boolean | "auto";
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
  const client = parts.metrics.client;
  // derive mode is opt-in and newer than the option, so it can default to "auto".
  const cumulativeSetting = options.deltaToCumulative ?? (client?.source === "derive" ? "auto" : false);
  const cumulative = genAiNeedsDeltaToCumulative(cumulativeSetting, metricExporters)
    ? [new DeltaToCumulativeProcessor({ name: "genai" })]
    : [];

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
      exporters: [parts.spanMetrics, parts.tokenUsage, ...(parts.clientMetrics ? [parts.clientMetrics] : [])],
    }),
    new Pipeline({
      signal: "metrics",
      name: "genai",
      receivers: [parts.spanMetrics, parts.tokenUsage, ...(parts.clientMetrics ? [parts.clientMetrics] : [])],
      processors: [...cumulative, batch],
      exporters: metricExporters,
    }),
  );
  if (client) {
    // The SDK's own metrics: the client metrics in passthrough, and the
    // ones no span carries (time to first chunk, gen_ai.server.*) either way.
    entities.push(
      new Pipeline({
        signal: "metrics",
        receivers: [otlp],
        processors: [memoryLimiter, ...(parts.sdkClientMetricsFilter ? [parts.sdkClientMetricsFilter] : []), batch],
        exporters: metricExporters,
      }),
    );
  }
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
