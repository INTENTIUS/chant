/**
 * `RedAlerts`: error-ratio and latency alerts per service over the span
 * metrics a `spanmetrics` connector emits.
 *
 * The names come from the connector's declaration through the otel lexicon's
 * `spanMetricsNames()`, and the expressions from its
 * `spanMetricsRedQueries()`, the same builder the grafana lexicon's
 * `RedDashboard` runs its panels on. The alert and the panel a responder
 * opens read one expression, with `rateWindow` in place of Grafana's
 * `$__rate_interval`.
 *
 * Both alerts count server and consumer spans only by default, like the
 * dashboard: a service's outgoing calls and internal spans don't dilute its
 * error ratio. Both are on by default; the latency alert needs the
 * connector's duration histogram and is left out without one unless asked
 * for.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import {
  promNumber,
  spanMetricsNames,
  spanMetricsRedQueries,
  type PrometheusNaming,
  type SpanMetricsKind,
  type SpanMetricsNames,
} from "@intentius/chant-lexicon-otel/metric-names";
import type { OTelComponent } from "@intentius/chant-lexicon-otel/define";
import type { SpanMetricsConnectorConfig } from "@intentius/chant-lexicon-otel/components/connectors";
import type { PrometheusExporterConfig } from "@intentius/chant-lexicon-otel/components/exporters";
import { RuleGroup, type AlertingRule, type RuleGroupEntity } from "../rules";
import type { LabelSet } from "../model";
import { durationMs, isValidDuration } from "../duration";

/** The fields both alerts take. */
export interface RedAlertOptions {
  /** How long the condition must hold (default `10m`). */
  for?: string;
  /** The `severity` label, which Alertmanager routes on (default `warning`). */
  severity?: string;
  /** More labels on the alert. */
  labels?: LabelSet;
  /** More annotations on the alert, e.g. `runbook_url`. */
  annotations?: LabelSet;
}

export interface RedErrorRatioAlert extends RedAlertOptions {
  /** The share of counted spans ending in error the alert fires above, between 0 and 1 (default 0.05). */
  threshold?: number;
}

export interface RedLatencyAlert extends RedAlertOptions {
  /** The duration quantile compared (default 0.95). */
  quantile?: number;
  /** The duration, in seconds, the quantile fires above (default 1). Converted to the histogram's unit. */
  thresholdSeconds?: number;
}

export interface RedAlertsProps {
  /** The `spanmetrics` connector the metrics come from (the otel lexicon's `RedMetrics` has it as `spanMetrics`), or the names `spanMetricsNames()` returned for it. */
  spanMetrics: OTelComponent<"connector", "spanmetrics", SpanMetricsConnectorConfig> | SpanMetricsNames;
  /** The `prometheus` exporter that serves them, when its `namespace` or `add_metric_suffixes` changes the names. */
  exporter?: OTelComponent<"exporter", "prometheus", PrometheusExporterConfig> | PrometheusNaming;
  /** Error ratio per service (default: on, above 0.05). `false` leaves it out. */
  errorRatio?: boolean | RedErrorRatioAlert;
  /** A duration quantile per service (default: on, p95 above 1s, when the connector has a histogram). `false` leaves it out. */
  latency?: boolean | RedLatencyAlert;
  /** The span kinds counted (default server and consumer spans); `[]` counts every kind. */
  spanKinds?: SpanMetricsKind[];
  /** The range every `rate` reads (default `5m`). */
  rateWindow?: string;
  /** Spans per second a service must see for its alerts to fire, so a handful of calls can't page (default: no floor). */
  minRate?: number;
  /** More Prometheus labels the alerts are split by besides the service, e.g. `deployment_environment`. They must be connector dimensions. */
  groupBy?: string[];
  /** The rule group's name (default `red`). */
  name?: string;
  /** Labels added to every rule, e.g. `team`. */
  labels?: LabelSet;
  /** Evaluation interval of the group (default: Prometheus's `evaluation_interval`). */
  interval?: string;
}

export type RedAlertsMembers = {
  /** The alerting rules. */
  rules: RuleGroupEntity;
};

/** What `RedAlerts(...)` returns: its rule group, as `rules`. */
export type RedAlertsInstance = CompositeInstance<RedAlertsMembers> & RedAlertsMembers;

const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The alert names `RedAlerts` writes. */
export const RED_ALERT_NAMES = Object.freeze({ errorRatio: "ServiceErrorRatioHigh", latency: "ServiceLatencyHigh" });

const DEFAULTS = { threshold: 0.05, quantile: 0.95, thresholdSeconds: 1, for: "10m", severity: "warning" };

function fail(message: string): never {
  throw new Error(`RedAlerts: ${message}`);
}

function isNames(x: unknown): x is SpanMetricsNames {
  return typeof x === "object" && x !== null && "calls" in x && "labels" in x && "errorStatus" in x;
}

function options<T extends RedAlertOptions>(value: boolean | T | undefined): T | undefined {
  if (value === false) return undefined;
  return value === undefined || value === true ? ({} as T) : value;
}

function checkOptions(at: string, a: RedAlertOptions): void {
  if (a.for !== undefined && !isValidDuration(a.for)) fail(`${at}.for "${a.for}" is not a Prometheus duration`);
  if (a.severity !== undefined && (typeof a.severity !== "string" || a.severity === "")) fail(`${at}.severity must be a non-empty string`);
}

/** The alerting rules `RedAlerts` builds, without the group: for a group of your own. */
export function redAlertRules(props: RedAlertsProps): AlertingRule[] {
  if (!props || typeof props !== "object") fail("props are required");
  if (!props.spanMetrics) fail("spanMetrics is required (a spanmetrics connector)");
  const names = isNames(props.spanMetrics) ? props.spanMetrics : spanMetricsNames(props.spanMetrics, props.exporter);
  const window = props.rateWindow ?? "5m";
  if (!isValidDuration(window) || !durationMs(window)) fail(`rateWindow "${window}" is not a positive Prometheus duration`);
  const groupBy = props.groupBy ?? [];
  for (const l of groupBy) if (!LABEL.test(l)) fail(`groupBy label "${l}" is not a Prometheus label name`);
  if (props.minRate !== undefined && !(typeof props.minRate === "number" && Number.isFinite(props.minRate) && props.minRate > 0)) {
    fail(`minRate must be above 0, got ${String(props.minRate)}`);
  }

  const err = options(props.errorRatio);
  // The latency alert is on by default only when there is a histogram to read.
  const lat = props.latency === undefined && !names.duration ? undefined : options(props.latency);
  if (lat && !names.duration) fail("latency needs the connector's duration histogram, and it is disabled");
  if (err) {
    checkOptions("errorRatio", err);
    const t = err.threshold;
    if (t !== undefined && !(typeof t === "number" && t > 0 && t < 1)) fail(`errorRatio.threshold must be above 0 and below 1, got ${String(t)}`);
  }
  if (lat) {
    checkOptions("latency", lat);
    const q = lat.quantile;
    if (q !== undefined && !(typeof q === "number" && q > 0 && q < 1)) fail(`latency.quantile must be between 0 and 1, got ${String(q)}`);
    const s = lat.thresholdSeconds;
    if (s !== undefined && !(typeof s === "number" && Number.isFinite(s) && s > 0)) fail(`latency.thresholdSeconds must be above 0, got ${String(s)}`);
  }

  const quantile = lat?.quantile ?? DEFAULTS.quantile;
  const q = spanMetricsRedQueries(names, { range: window, quantiles: [quantile], spanKinds: props.spanKinds, by: groupBy, owner: "RedAlerts" });
  const by = [q.service, ...groupBy];
  const floor = props.minRate !== undefined ? `\nand on (${by.join(", ")})\n${q.rate} > ${promNumber(props.minRate)}` : "";
  const svc = `{{ $labels.${q.service} }}`;
  const out: AlertingRule[] = [];
  const build = (o: RedAlertOptions, alert: string, expr: string, summary: string, description: string) => {
    out.push({
      alert,
      expr,
      for: o.for ?? DEFAULTS.for,
      labels: { ...(o.labels ?? {}), severity: o.severity ?? DEFAULTS.severity },
      annotations: { summary, description, ...(o.annotations ?? {}) },
    });
  };

  if (err) {
    const threshold = err.threshold ?? DEFAULTS.threshold;
    build(
      err,
      RED_ALERT_NAMES.errorRatio,
      `${q.errorRatio} > ${promNumber(threshold)}${floor}`,
      `Error ratio above ${promNumber(threshold * 100)}% for ${svc}`,
      `{{ $value | humanizePercentage }} of ${svc} spans ended in error over the last ${window}.`,
    );
  }
  if (lat && names.duration) {
    const seconds = lat.thresholdSeconds ?? DEFAULTS.thresholdSeconds;
    const inUnit = names.duration.unit === "s" ? seconds : seconds * 1000;
    const qName = `p${promNumber(quantile * 100)}`;
    const shown = names.duration.unit === "s" ? "{{ $value | humanizeDuration }}" : "{{ $value | printf \"%.0f\" }}ms";
    build(
      lat,
      RED_ALERT_NAMES.latency,
      `${q.duration[0].expr} > ${promNumber(inUnit)}${floor}`,
      `${qName} duration above ${promNumber(seconds)}s for ${svc}`,
      `${qName} duration of ${svc} is ${shown} over the last ${window}.`,
    );
  }
  return out;
}

/**
 * Error-ratio and latency alerts per service, from a `spanmetrics` connector.
 *
 * @example
 * ```ts
 * import { RedMetrics } from "@intentius/chant-lexicon-otel";
 * import { RedAlerts } from "@intentius/chant-lexicon-prometheus";
 *
 * export const red = RedMetrics({ spanMetrics: { namespace: "shop", histogram: { unit: "s" } } });
 * export const redAlerts = RedAlerts({ spanMetrics: red.spanMetrics, exporter: red.exporter, latency: { thresholdSeconds: 0.5 } });
 * ```
 */
export const RedAlerts = Composite<RedAlertsProps, RedAlertsMembers>((props) => {
  const rules = redAlertRules(props);
  const name = props.name ?? "red";
  if (!GROUP_NAME.test(name)) fail(`name "${name}" must be letters, digits, '.', '_' or '-'`);
  if (rules.length === 0) fail("errorRatio and latency are both off, so there is nothing to alert on");
  const group = new RuleGroup({
    name,
    ...(props.interval !== undefined ? { interval: props.interval } : {}),
    ...(props.labels !== undefined ? { labels: props.labels } : {}),
    rules,
  });
  return { rules: group };
}, "RedAlerts");
