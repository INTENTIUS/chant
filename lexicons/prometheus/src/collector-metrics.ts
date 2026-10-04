/**
 * The metric names the collector configs in a build emit through their
 * `spanmetrics`, `servicegraph`, `sum` and `signaltometrics` connectors (the
 * last two are how the otel GenAI preset counts tokens and derives the
 * conventions' client metrics), and the PromQL that reads under those
 * connectors' namespaces without matching one of them (PROM301).
 *
 * Grafana's GRAF118 runs `collectorMetricIssues` over panel queries; the
 * prometheus lexicon runs it over rule files. Names follow the otel lexicon's
 * `metric-names.ts`, with each config's `prometheus` and
 * `prometheusremotewrite` exporters' `namespace` and `add_metric_suffixes`.
 * A component under a renamed type (`span_metrics`, `service_graph`,
 * `signal_to_metrics`) is read as the built-in it names, through the otel
 * lexicon's `canonicalTypeOf`.
 *
 * Collector configs come from two places. `chant build` gives a lexicon's
 * checks only that lexicon's output, but every entity in the build, so the
 * otel lexicon's own config is rebuilt from the build's otel entities with
 * `buildCollectorConfig`. Any output document shaped like a collector config,
 * or a Kubernetes ConfigMap holding one, is read as well.
 */

import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { buildCollectorConfig } from "@intentius/chant-lexicon-otel/collector";
import { isOTelComponent } from "@intentius/chant-lexicon-otel/define";
import { collectorConfigs } from "@intentius/chant-lexicon-otel/lint/post-synth/otel-helpers";
import {
  prometheusLabel,
  prometheusMetricName,
  serviceGraphNames,
  spanMetricsNames,
  SERVICEGRAPH_NAMESPACE,
  SPANMETRICS_DEFAULT_NAMESPACE,
  type CollectorMetric,
  type PrometheusNaming,
  type SpanMetricsNamingConfig,
} from "@intentius/chant-lexicon-otel/metric-names";
import { canonicalTypeOf, type CollectorConfig } from "@intentius/chant-lexicon-otel/model";
import { parsePromql, selectors } from "./promql-analysis";

type SyntaxNode = NonNullable<ReturnType<typeof parsePromql>>;
type Obj = Record<string, unknown>;

/** One metric a collector config emits, as Prometheus sees it. */
export interface EmittedMetric {
  /** The connector that emits it, e.g. `spanmetrics/genai`. */
  connector: string;
  /** The labels a series of it can carry; undefined when the exporter adds every resource attribute. */
  labels?: Set<string>;
}

/** What the collector configs in a build emit. */
export interface CollectorMetrics {
  /** The name prefixes the connectors own, e.g. `traces_span_metrics_`. */
  namespaces: string[];
  /** Every emitted Prometheus name. A histogram is its `_bucket`, `_sum` and `_count` series. */
  metrics: Map<string, EmittedMetric[]>;
}

/** Labels the `prometheus` exporter, or the scrape, adds to every series: `job` and `instance` from the resource, and the scope. */
const ADDED_LABELS = ["job", "instance", "otel_scope_name", "otel_scope_version", "otel_scope_schema_url"];

function asObj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

/** A component's type, with a renamed built-in's new name read as the old one (`span_metrics/genai` is `spanmetrics`). */
function typeOf(kind: "connector" | "exporter", id: string): string {
  return canonicalTypeOf(kind, id);
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_:]/g, "_");
}

/** The common dotted prefix of a connector's metric names (`genai.tokens` for `genai.tokens.input` and `.output`). */
function commonPrefix(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  const split = names.map((n) => n.split("."));
  const out: string[] = [];
  for (let i = 0; i < split[0].length - 1; i++) {
    if (split.every((s) => s.length - 1 > i && s[i] === split[0][i])) out.push(split[0][i]);
    else break;
  }
  if (out.length === 0 && names.length === 1 && split[0].length > 1) return split[0].slice(0, -1).join(".");
  return out.length > 0 ? out.join(".") : undefined;
}

/** Every collector config in the build: rebuilt from its otel entities, and found in its output. */
export function buildCollectorConfigs(ctx: PostSynthContext): CollectorConfig[] {
  const configs = collectorConfigs(ctx).map((f) => f.config);
  const otel = [...(ctx.entities?.values() ?? [])].filter((e) => e?.lexicon === "otel");
  if (otel.some(isOTelComponent)) configs.push(buildCollectorConfig(otel).config);
  return configs;
}

/** The metrics the collector configs emit; undefined when there are none. */
export function collectorMetrics(configs: CollectorConfig[]): CollectorMetrics | undefined {
  if (configs.length === 0) return undefined;
  const namespaces = new Set<string>();
  const metrics = new Map<string, EmittedMetric[]>();

  for (const config of configs) {
    const exporters = Object.entries(asObj(config.exporters)).filter(([id]) => typeOf("exporter", id) === "prometheus" || typeOf("exporter", id) === "prometheusremotewrite");
    const namings: Array<{ naming: PrometheusNaming; openLabels: boolean }> =
      exporters.length > 0
        ? exporters.map(([, c]) => {
            const e = asObj(c);
            return {
              naming: { ...(typeof e.namespace === "string" ? { namespace: e.namespace } : {}), ...(e.add_metric_suffixes === false ? { add_metric_suffixes: false } : {}) },
              openLabels: asObj(e.resource_to_telemetry_conversion).enabled === true,
            };
          })
        : [{ naming: {}, openLabels: false }];

    for (const { naming, openLabels } of namings) {
      const prefix = (ns: string) => `${naming.namespace ? `${sanitize(naming.namespace)}_` : ""}${sanitize(ns)}_`;
      // The two connectors' defaults are theirs in every build that has a collector config.
      namespaces.add(prefix(SPANMETRICS_DEFAULT_NAMESPACE));
      namespaces.add(prefix(SERVICEGRAPH_NAMESPACE));

      const add = (connector: string, m: CollectorMetric, extra: string[] = []) => {
        const labels = openLabels ? undefined : new Set([...m.dimensions.map(prometheusLabel), ...extra.map(prometheusLabel), ...ADDED_LABELS]);
        // A classic histogram is served as three series whatever add_metric_suffixes says.
        const series: Array<[string, Set<string> | undefined]> =
          m.type === "histogram"
            ? [
                [`${m.prometheus}_bucket`, labels ? new Set([...labels, "le"]) : undefined],
                [`${m.prometheus}_sum`, labels],
                [`${m.prometheus}_count`, labels],
              ]
            : [[m.prometheus, labels]];
        for (const [name, l] of series) {
          metrics.set(name, [...(metrics.get(name) ?? []), { connector, ...(l ? { labels: l } : {}) }]);
        }
      };

      for (const [id, raw] of Object.entries(asObj(config.connectors))) {
        const c = asObj(raw);
        switch (typeOf("connector", id)) {
          case "spanmetrics": {
            const n = spanMetricsNames(c as SpanMetricsNamingConfig, naming);
            if (n.namespace !== "") namespaces.add(prefix(n.namespace));
            for (const m of [n.calls, n.duration, n.events]) if (m) add(id, m);
            break;
          }
          case "servicegraph": {
            const n = serviceGraphNames(c, naming);
            for (const m of [n.requests, n.failed, n.serverDuration, n.clientDuration]) add(id, m);
            break;
          }
          case "sum": {
            const names: string[] = [];
            for (const signal of ["spans", "spanevents", "metrics", "datapoints", "logs"]) {
              for (const [name, def] of Object.entries(asObj(c[signal]))) {
                const attrs = (Array.isArray(asObj(def).attributes) ? (asObj(def).attributes as unknown[]) : []).map((a) => String(asObj(a).key ?? ""));
                names.push(name);
                add(id, { name, prometheus: prometheusMetricName(name, "sum", undefined, naming), type: "sum", dimensions: attrs.filter(Boolean) });
              }
            }
            const ns = commonPrefix(names);
            if (ns) namespaces.add(prefix(ns));
            break;
          }
          case "signaltometrics": {
            const names: string[] = [];
            for (const signal of ["spans", "datapoints", "logs", "profiles"]) {
              for (const def of Array.isArray(c[signal]) ? (c[signal] as unknown[]) : []) {
                const m = asObj(def);
                if (typeof m.name !== "string") continue;
                const type = m.histogram !== undefined || m.exponential_histogram !== undefined ? "histogram" : m.sum !== undefined ? "sum" : undefined;
                if (!type) continue;
                const unit = typeof m.unit === "string" ? m.unit : undefined;
                const attrs = [
                  ...(Array.isArray(m.attributes) ? (m.attributes as unknown[]) : []),
                  ...(Array.isArray(m.include_resource_attributes) ? (m.include_resource_attributes as unknown[]) : []),
                ].map((a) => String(asObj(a).key ?? ""));
                names.push(m.name);
                add(id, { name: m.name, prometheus: prometheusMetricName(m.name, type, unit, naming), type, ...(unit ? { unit } : {}), dimensions: attrs.filter(Boolean) });
              }
            }
            const ns = commonPrefix(names);
            if (ns) namespaces.add(prefix(ns));
            break;
          }
        }
      }
    }
  }
  return { namespaces: [...namespaces], metrics };
}

// ── PromQL ──────────────────────────────────────────────────────────

/** Functions that write a label of their own, so an aggregation over them can group by it. */
const RELABEL = new Set(["label_replace", "label_join"]);

/** Every `by (...)` aggregation in the expression: its labels and the text it aggregates. */
function byAggregations(top: SyntaxNode, src: string): Array<{ labels: string[]; body: string }> {
  const out: Array<{ labels: string[]; body: string }> = [];
  const walk = (n: SyntaxNode) => {
    if (n.name === "AggregateExpr") {
      const mod = n.getChild("AggregateModifier");
      const body = n.getChild("FunctionCallBody");
      if (mod?.getChild("By") && body) {
        const labels = (mod.getChild("GroupingLabels")?.getChildren("LabelName") ?? []).map((l) => src.slice(l.from, l.to));
        out.push({ labels, body: src.slice(body.from + 1, body.to - 1) });
      }
    }
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(top);
  return out;
}

export interface CollectorMetricIssue {
  kind: "name" | "label";
  metric: string;
  label?: string;
  message: string;
}

/**
 * What a PromQL expression reads under the build's connector namespaces and
 * the build does not emit: a metric name no connector writes, and a
 * `by (...)` label none of the aggregated metrics carries. A name outside
 * every namespace is not read. An aggregation is checked only when every
 * series under it is an emitted metric and nothing under it adds a label
 * (`label_replace`, `label_join`). Selectors come from the lexicon's
 * `promql-analysis.ts`.
 */
export function collectorMetricIssues(expr: string, emitted: CollectorMetrics): CollectorMetricIssue[] {
  const top = parsePromql(expr);
  if (!top) return [];
  const issues: CollectorMetricIssue[] = [];
  const owned = (name: string) => emitted.namespaces.some((p) => name.startsWith(p));

  const seen = new Set<string>();
  for (const { name } of selectors(expr)) {
    if (!name || seen.has(name) || !owned(name) || emitted.metrics.has(name)) continue;
    seen.add(name);
    const p = emitted.namespaces.filter((x) => name.startsWith(x)).sort((a, b) => b.length - a.length)[0];
    issues.push({ kind: "name", metric: name, message: `reads ${name}, which no collector config in the build emits under ${p.slice(0, -1)}` });
  }

  const reported = new Set<string>();
  for (const { labels, body } of byAggregations(top, expr)) {
    const read = selectors(body);
    if (read.length === 0 || read.some((s) => s.within.some((fn) => RELABEL.has(fn)))) continue;
    const metrics = read.map((s) => (s.name ? emitted.metrics.get(s.name) : undefined));
    if (!metrics.every((m) => m !== undefined && m.every((e) => e.labels))) continue;
    const carried = new Set(metrics.flatMap((m) => m!.flatMap((e) => [...e.labels!])));
    const shown = [...new Set(read.map((s) => s.name!))].join(", ");
    for (const label of labels) {
      const key = `${label} ${shown}`;
      if (carried.has(label) || reported.has(key)) continue;
      reported.add(key);
      issues.push({ kind: "label", metric: shown, label, message: `groups ${shown} by ${label}, which is not a dimension the collector config declares for it` });
    }
  }
  return issues;
}
