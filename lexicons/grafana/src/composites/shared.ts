/**
 * What the dashboard composites share: the dashboard-level props they all
 * take, a PromQL selector builder, and the field configs they reuse.
 */

import {
  promErrorRatio,
  promNumber,
  promQuantile,
  promSelector,
  promSumRate,
  type PromMatcher,
} from "@intentius/chant-lexicon-otel/metric-names";
import type { DatasourceInput } from "../query";
import type { DashboardLinkInput } from "../dashboard";
import type { FolderEntity } from "../folder";
import type { ThresholdsConfig } from "../schema/dashboard.gen";

/** Dashboard settings every composite takes; each has a default derived from what it reads. */
export interface DashboardOptions {
  /** The Prometheus the metrics are queried from: a declared `Datasource`, or `{ type: "prometheus", uid }` for one declared elsewhere. */
  datasource: DatasourceInput<"prometheus">;
  title?: string;
  /** The dashboard uid. Defaults to one derived from the source declaration. */
  uid?: string;
  description?: string;
  tags?: string[];
  /** The Grafana folder to provision it into: a path, or a `Folder` to pin its uid. */
  folder?: string | FolderEntity;
  /** Initial time range. */
  time?: { from: string; to: string };
  /** Auto-refresh interval, e.g. `30s`. */
  refresh?: string;
  links?: DashboardLinkInput[];
}

/** A label matcher: `[label, op, value]`. */
export type Matcher = PromMatcher;

// The PromQL builders live in the otel lexicon's metric-names, next to the
// names they read, so the prometheus lexicon's RedAlerts builds the same
// expressions without importing grafana. Here they default the range to
// Grafana's `$__rate_interval`.

/** `metric{a="x", b=~"y"}`; just `metric` with no matchers. */
export function selector(metric: string, matchers: Matcher[]): string {
  return promSelector(metric, matchers);
}

/** `sum by (labels) (rate(sel[range]))`, or `sum (...)` with no labels. */
export function sumRate(sel: string, by: string[], range = "$__rate_interval"): string {
  return promSumRate(sel, by, range);
}

/**
 * `errors / all` as rates summed by `by`, with the numerator padded to zero:
 * `(errors or all * 0) / all`. A group with calls but no error series gets
 * 0 instead of dropping out of the result, so a panel shows 0% rather than
 * "No data" for a service that has had no errors.
 */
export function errorRatio(errorSel: string, allSel: string, by: string[]): string {
  return promErrorRatio(errorSel, allSel, by, "$__rate_interval");
}

/** `histogram_quantile(q, sum by (le, labels) (rate(bucket[range])))`. */
export function quantile(q: number, bucketSel: string, by: string[]): string {
  return promQuantile(q, bucketSel, by, "$__rate_interval");
}

/** A number as PromQL and Grafana thresholds write it, without float noise. */
export function num(n: number): string {
  return promNumber(n);
}

/** `p95` for 0.95, `p99.9` for 0.999. */
export function quantileName(q: number): string {
  return `p${num(q * 100)}`;
}

/** Legend text naming the label, `{{service_name}}`. */
export function legend(...labels: string[]): string {
  return labels.map((l) => `{{${l}}}`).join(" ");
}

/** Grafana's unit id for a spanmetrics histogram unit (`ms` or `s`). */
export function durationUnit(unit: string | undefined): string {
  return unit === "s" ? "s" : "ms";
}

/** Absolute thresholds from a base colour and `[value, colour]` steps. */
export function thresholds(base: string, steps: Array<[number, string]>): ThresholdsConfig {
  return { mode: "absolute", steps: [{ value: null, color: base }, ...steps.map(([value, color]) => ({ value, color }))] };
}

/** The props a composite passes to `Dashboard`, from the options and its own defaults. */
export function dashboardProps(o: DashboardOptions, defaults: { title: string; uid: string; description: string; tags: string[] }) {
  return {
    title: o.title ?? defaults.title,
    uid: o.uid ?? defaults.uid,
    description: o.description ?? defaults.description,
    tags: o.tags ?? defaults.tags,
    time: o.time ?? { from: "now-6h", to: "now" },
    ...(o.refresh !== undefined ? { refresh: o.refresh } : { refresh: "1m" }),
    graphTooltip: "sharedCrosshair" as const,
    ...(o.folder !== undefined ? { folder: o.folder } : {}),
    ...(o.links !== undefined ? { links: o.links } : {}),
  };
}

/** Throw unless a Prometheus datasource was passed. */
export function requireDatasource(composite: string, ds: unknown): void {
  if (ds === undefined || ds === null) throw new Error(`${composite}: datasource is required (a Prometheus Datasource or { type: "prometheus", uid })`);
  const type = (ds as { datasourceType?: unknown; pluginType?: unknown; type?: unknown }).datasourceType ??
    (ds as { pluginType?: unknown }).pluginType ??
    (ds as { type?: unknown }).type;
  if (type !== "prometheus") throw new Error(`${composite}: datasource must be a Prometheus datasource, got ${String(type)}`);
}
