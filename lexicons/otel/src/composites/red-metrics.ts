/**
 * `RedMetrics`: rate, errors and duration (RED) metrics from traces, served
 * for Prometheus to scrape.
 *
 * Spans come in on an `otlp` receiver (or the receivers given) and go
 * through `memory_limiter` and `batch` to a `spanmetrics` connector and, by
 * default, a `servicegraph` connector. Both feed a `metrics` pipeline that
 * ends at a `prometheus` exporter on 0.0.0.0:8889. Traces can also go on to
 * a backend through `traceExporters`.
 *
 * The metric names follow from the declaration: `redMetricsNames(red)` reads
 * them back with `spanMetricsNames()` and `serviceGraphNames()`, and the
 * grafana lexicon's `RedDashboard` and the prometheus lexicon's `RedAlerts`
 * take the connector and the exporter (`red.spanMetrics`, `red.exporter`),
 * so a renamed namespace moves every query built from them.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { OtlpReceiver } from "../components/receivers";
import { BatchProcessor, MemoryLimiterProcessor } from "../components/processors";
import {
  ServiceGraphConnector,
  SpanMetricsConnector,
  type ServiceGraphConnectorConfig,
  type SpanMetricsConnectorConfig,
} from "../components/connectors";
import { PrometheusExporter, type PrometheusExporterConfig } from "../components/exporters";
import type { OTelComponent } from "../define";
import { Pipeline, type PipelineEntity } from "../pipeline";
import { serviceGraphNames, spanMetricsNames, type ServiceGraphNames, type SpanMetricsNames } from "../metric-names";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Exporter = OTelComponent<"exporter", string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TraceSource = OTelComponent<"receiver" | "connector", string, any>;
type Component<K extends "receiver" | "processor" | "exporter" | "connector"> = OTelComponent<K, string, object>;

export interface RedMetricsProps {
  /** Where spans come from: receivers, or a connector from another traces pipeline. Default: an `otlp` receiver on 4317 (gRPC) and 4318 (HTTP). */
  receivers?: TraceSource[];
  /** Where traces go besides the connectors, e.g. a tracing backend. Default: nowhere. */
  traceExporters?: Exporter[];
  /** The `prometheus` exporter the metrics are served on. Default: one named after `name`, on 0.0.0.0:8889. */
  exporter?: OTelComponent<"exporter", "prometheus", PrometheusExporterConfig>;
  /** The `spanmetrics` connector's config: namespace, dimensions, histogram unit and buckets (default: the connector's defaults). */
  spanMetrics?: SpanMetricsConnectorConfig;
  /** Service-to-service edge metrics from a `servicegraph` connector (default: on). */
  serviceGraph?: boolean | ServiceGraphConnectorConfig;
  /** `memory_limiter`'s hard limit in MiB (default: 80% of the container's memory, with a 20% spike limit). */
  memoryLimitMib?: number;
  /** The instance name of the connectors, the exporter and the two pipelines (default `red`). */
  name?: string;
}

// A type alias, not an interface: a composite's members type needs the implicit index signature.
export type RedMetricsMembers = {
  otlp?: Component<"receiver">;
  memoryLimiter: Component<"processor">;
  batch: Component<"processor">;
  spanMetrics: OTelComponent<"connector", "spanmetrics", SpanMetricsConnectorConfig>;
  serviceGraph?: OTelComponent<"connector", "servicegraph", ServiceGraphConnectorConfig>;
  exporter: OTelComponent<"exporter", "prometheus", PrometheusExporterConfig>;
  traces: PipelineEntity;
  metrics: PipelineEntity;
};

export type RedMetricsInstance = CompositeInstance<RedMetricsMembers> & RedMetricsMembers;

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Why a set of `RedMetrics` props can't build, or undefined when they can. */
export function redMetricsPropsProblem(props: RedMetricsProps = {}): string | undefined {
  if (props.receivers !== undefined && props.receivers.length === 0) return "receivers must name at least one receiver when set";
  if (props.memoryLimitMib !== undefined && !(Number.isInteger(props.memoryLimitMib) && props.memoryLimitMib > 0)) {
    return "memoryLimitMib must be a positive whole number";
  }
  if (props.name !== undefined && !NAME.test(props.name)) return `name "${props.name}" must be letters, digits, '.', '_' or '-'`;
  if (props.exporter !== undefined && props.exporter.componentType !== "prometheus") {
    return `exporter must be a prometheus exporter, got ${props.exporter.componentType}`;
  }
  return undefined;
}

/**
 * RED metrics from traces: `spanmetrics` and `servicegraph` connectors
 * feeding a `prometheus` exporter.
 *
 * @example
 * ```ts
 * import { RedMetrics, OtlpExporter } from "@intentius/chant-lexicon-otel";
 *
 * const tempo = new OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: { insecure: true } });
 * export const red = RedMetrics({ traceExporters: [tempo], spanMetrics: { namespace: "shop", histogram: { unit: "s" } } });
 * // RedDashboard({ spanMetrics: red.spanMetrics, exporter: red.exporter, datasource }) in the grafana lexicon
 * ```
 */
export const RedMetrics = Composite<RedMetricsProps, RedMetricsMembers>((input) => {
  const props = input ?? {};
  const problem = redMetricsPropsProblem(props);
  if (problem) throw new Error(`RedMetrics: ${problem}`);
  const name = props.name ?? "red";

  const otlp = props.receivers
    ? undefined
    : new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } } });
  const receivers: TraceSource[] = props.receivers ?? [otlp!];
  const memoryLimiter = new MemoryLimiterProcessor(
    props.memoryLimitMib !== undefined
      ? { check_interval: "1s", limit_mib: props.memoryLimitMib, spike_limit_mib: Math.ceil(props.memoryLimitMib / 4) }
      : { check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 },
  );
  const batch = new BatchProcessor({});
  const spanMetrics = new SpanMetricsConnector({ name, ...(props.spanMetrics ?? {}) });
  const graphConfig = props.serviceGraph === undefined || props.serviceGraph === true ? {} : props.serviceGraph === false ? undefined : props.serviceGraph;
  const serviceGraph = graphConfig ? new ServiceGraphConnector({ name, ...graphConfig }) : undefined;
  const exporter = props.exporter ?? new PrometheusExporter({ name, endpoint: "0.0.0.0:8889" });
  const connectors = [spanMetrics, ...(serviceGraph ? [serviceGraph] : [])];

  const traces = new Pipeline({
    signal: "traces",
    name,
    receivers,
    processors: [memoryLimiter, batch],
    exporters: [...connectors, ...(props.traceExporters ?? [])],
  });
  const metrics = new Pipeline({ signal: "metrics", name, receivers: connectors, processors: [batch], exporters: [exporter] });

  // A composite member must be a declarable, so the components that are off are left out rather than undefined.
  const members: RedMetricsMembers = { memoryLimiter, batch, spanMetrics, exporter, traces, metrics };
  if (otlp) members.otlp = otlp;
  if (serviceGraph) members.serviceGraph = serviceGraph;
  return members;
}, "RedMetrics");

/** The Prometheus names of what a `RedMetrics` serves: the span metrics, and the service graph's when it is on. */
export interface RedMetricsNames {
  spans: SpanMetricsNames;
  serviceGraph?: ServiceGraphNames;
}

/** The metric names a `RedMetrics(...)` result serves, read from its connectors and exporter. */
export function redMetricsNames(red: RedMetricsInstance | RedMetricsMembers): RedMetricsNames {
  if (!red?.spanMetrics || !red.exporter) throw new Error("redMetricsNames: pass a RedMetrics(...) result");
  return {
    spans: spanMetricsNames(red.spanMetrics, red.exporter),
    ...(red.serviceGraph ? { serviceGraph: serviceGraphNames(red.serviceGraph, red.exporter) } : {}),
  };
}
