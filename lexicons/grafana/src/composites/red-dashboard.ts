/**
 * `RedDashboard`: rate, errors and duration per service, from a
 * `spanmetrics` connector declaration.
 *
 * The metric names come from the connector's config through the otel
 * lexicon's `spanMetricsNames()`: its namespace, its histogram unit, the
 * default dimensions it keeps, and optionally the `prometheus` exporter's
 * namespace. Renaming the connector's namespace moves every query here.
 *
 * The queries count server and consumer spans only by default, the spans
 * that handle a request or a message, so a service's outgoing calls and
 * its internal spans don't inflate its rate or dilute its error ratio.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { spanMetricsNames, type PrometheusNaming, type SpanMetricsNames } from "@intentius/chant-lexicon-otel/metric-names";
import type { OTelComponent } from "@intentius/chant-lexicon-otel/define";
import type { SpanMetricsConnectorConfig } from "@intentius/chant-lexicon-otel/components/connectors";
import type { PrometheusExporterConfig } from "@intentius/chant-lexicon-otel/components/exporters";
import { Dashboard, type DashboardEntity } from "../dashboard";
import { Row, TimeSeriesPanel } from "../panels";
import { PromQuery } from "../query";
import { QueryVariable } from "../variables";
import { slugUid } from "../util";
import {
  dashboardProps,
  durationUnit,
  errorRatio,
  legend,
  quantile,
  quantileName,
  requireDatasource,
  selector,
  sumRate,
  type DashboardOptions,
  type Matcher,
} from "./shared";

export interface RedDashboardProps extends DashboardOptions {
  /**
   * The `spanmetrics` connector the metrics come from, or the names
   * `spanMetricsNames()` returned for it.
   */
  spanMetrics: OTelComponent<"connector", "spanmetrics", SpanMetricsConnectorConfig> | SpanMetricsNames;
  /** The `prometheus` exporter that serves them, when its `namespace` or `add_metric_suffixes` changes the names. */
  exporter?: OTelComponent<"exporter", "prometheus", PrometheusExporterConfig> | PrometheusNaming;
  /** Duration quantiles, one panel each (default p50, p95 and p99). */
  quantiles?: number[];
  /**
   * The span kinds the queries count (default server and consumer spans).
   * `[]` counts every kind. With the default, a connector that excludes
   * `span.kind` gets no kind filter; naming kinds for such a connector is
   * an error.
   */
  spanKinds?: SpanKind[];
}

/** The `span_kind` label values the spanmetrics connector writes. */
export type SpanKind =
  | "SPAN_KIND_UNSPECIFIED"
  | "SPAN_KIND_INTERNAL"
  | "SPAN_KIND_SERVER"
  | "SPAN_KIND_CLIENT"
  | "SPAN_KIND_PRODUCER"
  | "SPAN_KIND_CONSUMER";

const SPAN_KINDS: readonly SpanKind[] = [
  "SPAN_KIND_UNSPECIFIED",
  "SPAN_KIND_INTERNAL",
  "SPAN_KIND_SERVER",
  "SPAN_KIND_CLIENT",
  "SPAN_KIND_PRODUCER",
  "SPAN_KIND_CONSUMER",
];

/** The kinds `RedDashboard` counts unless told otherwise: the spans that serve a request or consume a message. */
export const RED_DEFAULT_SPAN_KINDS: readonly SpanKind[] = Object.freeze(["SPAN_KIND_SERVER", "SPAN_KIND_CONSUMER"]);

export type RedDashboardMembers = { dashboard: DashboardEntity };

/** What `RedDashboard(...)` returns: its dashboard, as `dashboard`. */
export type RedDashboardInstance = CompositeInstance<RedDashboardMembers> & RedDashboardMembers;

const DEFAULT_QUANTILES = [0.5, 0.95, 0.99];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isNames(x: unknown): x is SpanMetricsNames {
  return typeof x === "object" && x !== null && "calls" in x && "labels" in x && "errorStatus" in x;
}

/**
 * The span-kind matcher for `kinds`, or none: none for `[]`, and none for
 * the default kinds when the connector excludes `span.kind`.
 */
function spanKindMatchers(names: SpanMetricsNames, kinds: readonly SpanKind[] | undefined): Matcher[] {
  const label = names.labels.spanKind;
  if (kinds === undefined) return label ? [[label, "=~", RED_DEFAULT_SPAN_KINDS.join("|")]] : [];
  for (const k of kinds) {
    if (!SPAN_KINDS.includes(k)) throw new Error(`RedDashboard: unknown span kind ${JSON.stringify(k)}; use one of ${SPAN_KINDS.join(", ")}`);
  }
  if (kinds.length === 0) return [];
  if (!label) throw new Error("RedDashboard: the connector excludes span.kind, so the metrics can't be filtered by spanKinds");
  return [[label, "=~", [...new Set(kinds)].join("|")]];
}

/**
 * The PromQL the RED dashboard runs, from the connector's names. Exposed for
 * tests and for panels of your own. `spanKinds` defaults to server and
 * consumer spans; `[]` counts every kind.
 */
export function redQueries(
  names: SpanMetricsNames,
  quantiles: number[] = DEFAULT_QUANTILES,
  serviceFilter = "$service",
  spanKinds?: readonly SpanKind[],
) {
  const svc = names.labels.service;
  const status = names.labels.statusCode;
  if (!svc) throw new Error("RedDashboard: the connector excludes service.name, so there is no service to break the metrics down by");
  if (!status) throw new Error("RedDashboard: the connector excludes status.code, so errors can't be told from successes");
  const kind = spanKindMatchers(names, spanKinds);
  const scope: Matcher[] = [[svc, "=~", serviceFilter], ...kind];
  const calls = selector(names.calls.prometheus, scope);
  const errors = selector(names.calls.prometheus, [...scope, [status, "=", names.errorStatus]]);
  const buckets = names.duration ? selector(`${names.duration.prometheus}_bucket`, scope) : undefined;
  return {
    rate: sumRate(calls, [svc]),
    errorRatio: errorRatio(errors, calls, [svc]),
    duration: buckets ? quantiles.map((q) => ({ quantile: q, expr: quantile(q, buckets, [svc]) })) : [],
    services: `label_values(${selector(names.calls.prometheus, kind)}, ${svc})`,
  };
}

/** "server and consumer spans", for panel descriptions. */
function kindsText(names: SpanMetricsNames, kinds: readonly SpanKind[] | undefined): string {
  const counted = kinds ?? (names.labels.spanKind ? RED_DEFAULT_SPAN_KINDS : []);
  if (counted.length === 0) return "spans";
  const words = [...new Set(counted)].map((k) => k.replace(/^SPAN_KIND_/, "").toLowerCase());
  return `${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0]} spans`;
}

/**
 * A RED dashboard (rate, errors, duration) per service, built from a
 * `spanmetrics` connector declaration.
 *
 * @example
 * ```ts
 * import { SpanMetricsConnector } from "@intentius/chant-lexicon-otel";
 * import { Datasource, RedDashboard } from "@intentius/chant-lexicon-grafana";
 *
 * export const spans = new SpanMetricsConnector({ namespace: "shop", histogram: { unit: "s" } });
 * export const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });
 * export const red = RedDashboard({ spanMetrics: spans, datasource: prometheus });
 * ```
 */
export const RedDashboard = Composite<RedDashboardProps, RedDashboardMembers>((props) => {
  requireDatasource("RedDashboard", props.datasource);
  if (!props.spanMetrics) throw new Error("RedDashboard: spanMetrics is required (a spanmetrics connector)");
  const names = isNames(props.spanMetrics) ? props.spanMetrics : spanMetricsNames(props.spanMetrics, props.exporter);
  const quantiles = props.quantiles ?? DEFAULT_QUANTILES;
  for (const q of quantiles) {
    if (!(typeof q === "number" && q > 0 && q < 1)) throw new Error(`RedDashboard: a quantile must be between 0 and 1, got ${String(q)}`);
  }
  const q = redQueries(names, quantiles, "$service", props.spanKinds);
  const counted = kindsText(names, props.spanKinds);
  const svc = names.labels.service!;
  const ds = props.datasource;

  const service = new QueryVariable({
    name: "service",
    label: "Service",
    datasource: ds,
    query: q.services,
    multi: true,
    includeAll: true,
    allValue: ".*",
    refresh: "onTimeRangeChange",
    sort: 1,
  });

  const rate = new TimeSeriesPanel({
    title: "Rate",
    description: `${cap(counted)} per second by service, from ${names.calls.prometheus}.`,
    datasource: ds,
    gridPos: { w: 12, h: 8 },
    targets: [new PromQuery({ expr: q.rate, legendFormat: legend(svc) })],
    fieldConfig: { defaults: { unit: "reqps" } },
  });
  const errors = new TimeSeriesPanel({
    title: "Errors",
    description: `Share of ${counted} with ${names.labels.statusCode}="${names.errorStatus}", by service.`,
    datasource: ds,
    gridPos: { w: 12, h: 8 },
    targets: [new PromQuery({ expr: q.errorRatio, legendFormat: legend(svc) })],
    fieldConfig: { defaults: { unit: "percentunit", min: 0 } },
  });

  const rows = [new Row({ title: "Rate and errors", panels: [rate, errors] })];
  if (names.duration && q.duration.length > 0) {
    const width = Math.max(6, Math.floor(24 / q.duration.length));
    const unit = durationUnit(names.duration.unit);
    const panels = q.duration.map(
      (d) =>
        new TimeSeriesPanel({
          title: `Duration ${quantileName(d.quantile)}`,
          description: `${quantileName(d.quantile)} duration of ${counted} by service, from ${names.duration!.prometheus}.`,
          datasource: ds,
          gridPos: { w: width, h: 8 },
          targets: [new PromQuery({ expr: d.expr, legendFormat: legend(svc) })],
          fieldConfig: { defaults: { unit } },
        }),
    );
    rows.push(new Row({ title: "Duration", panels }));
  }

  const dashboard = new Dashboard({
    ...dashboardProps(props, {
      title: "Services: rate, errors, duration",
      uid: slugUid(`red-${names.namespace || "spans"}`),
      description: `Rate, errors and duration per service from the ${names.namespace || "unprefixed"} span metrics.`,
      tags: ["red", "spanmetrics"],
    }),
    variables: [service],
    panels: rows,
  });
  return { dashboard };
}, "RedDashboard");
