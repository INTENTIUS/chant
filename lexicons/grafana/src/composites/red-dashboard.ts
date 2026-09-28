/**
 * `RedDashboard`: rate, errors and duration per service, from a
 * `spanmetrics` connector declaration.
 *
 * The metric names come from the connector's config through the otel
 * lexicon's `spanMetricsNames()`: its namespace, its histogram unit, the
 * default dimensions it keeps, and optionally the `prometheus` exporter's
 * namespace. Renaming the connector's namespace moves every query here.
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
}

export type RedDashboardMembers = { dashboard: DashboardEntity };

/** What `RedDashboard(...)` returns: its dashboard, as `dashboard`. */
export type RedDashboardInstance = CompositeInstance<RedDashboardMembers> & RedDashboardMembers;

const DEFAULT_QUANTILES = [0.5, 0.95, 0.99];

function isNames(x: unknown): x is SpanMetricsNames {
  return typeof x === "object" && x !== null && "calls" in x && "labels" in x && "errorStatus" in x;
}

/** The PromQL the RED dashboard runs, from the connector's names. Exposed for tests and for panels of your own. */
export function redQueries(names: SpanMetricsNames, quantiles: number[] = DEFAULT_QUANTILES, serviceFilter = "$service") {
  const svc = names.labels.service;
  const status = names.labels.statusCode;
  if (!svc) throw new Error("RedDashboard: the connector excludes service.name, so there is no service to break the metrics down by");
  if (!status) throw new Error("RedDashboard: the connector excludes status.code, so errors can't be told from successes");
  const bySvc: Matcher[] = [[svc, "=~", serviceFilter]];
  const calls = selector(names.calls.prometheus, bySvc);
  const errors = selector(names.calls.prometheus, [...bySvc, [status, "=", names.errorStatus]]);
  const buckets = names.duration ? selector(`${names.duration.prometheus}_bucket`, bySvc) : undefined;
  return {
    rate: sumRate(calls, [svc]),
    errorRatio: `${sumRate(errors, [svc])}\n/\n${sumRate(calls, [svc])}`,
    duration: buckets ? quantiles.map((q) => ({ quantile: q, expr: quantile(q, buckets, [svc]) })) : [],
    services: `label_values(${names.calls.prometheus}, ${svc})`,
  };
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
  const q = redQueries(names, quantiles);
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
    description: `Spans per second by service, from ${names.calls.prometheus}.`,
    datasource: ds,
    gridPos: { w: 12, h: 8 },
    targets: [new PromQuery({ expr: q.rate, legendFormat: legend(svc) })],
    fieldConfig: { defaults: { unit: "reqps" } },
  });
  const errors = new TimeSeriesPanel({
    title: "Errors",
    description: `Share of spans with ${names.labels.statusCode}="${names.errorStatus}", by service.`,
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
          description: `${quantileName(d.quantile)} span duration by service, from ${names.duration!.prometheus}.`,
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
