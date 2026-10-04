/**
 * GRAF118 (#3364): panel queries under a connector namespace against what the
 * build's collector configs emit, through the prometheus lexicon's helper.
 */
import { describe, expect, test } from "vitest";
import { makePostSynthCtxFromFiles } from "@intentius/chant-test-utils";
import type { Declarable } from "@intentius/chant/declarable";
import { PrometheusExporter, SpanMetricsConnector } from "@intentius/chant-lexicon-otel/components/index";
import { genAiComponents, genAiPipeline, type GenAiMetricsOptions } from "@intentius/chant-lexicon-otel/genai";
import { GenAiRules } from "@intentius/chant-lexicon-prometheus/composites/genai";
import { grafanaSerializer } from "../../serializer";
import { Datasource } from "../../datasource";
import { Dashboard } from "../../dashboard";
import { TimeSeriesPanel } from "../../panels";
import { PromQuery } from "../../query";
import { AgentDashboard, RedDashboard } from "../../composites/index";
import { graf118 } from "./graf118";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });

/** Serialize the grafana entities the way a build does; every entity, the collector's included, is in the context. */
function check(...list: Declarable[]): string[] {
  const entities = new Map(list.map((e, i) => [`e${i}`, e] as [string, Declarable]));
  const out = grafanaSerializer.serialize(entities);
  if (typeof out === "string") throw new Error("expected files");
  return graf118.check(makePostSynthCtxFromFiles("grafana", out.files!, out.primary, entities)).map((d) => d.message);
}

const panel = (expr: string) =>
  new Dashboard({ title: "D", panels: [new TimeSeriesPanel({ title: "p", datasource: prometheus, targets: [new PromQuery({ expr })] })] });

describe("GRAF118", () => {
  test("a panel reading a spanmetrics name no connector emits, or grouping by an undeclared label", () => {
    const spans = new SpanMetricsConnector({ namespace: "shop" });
    expect(check(prometheus, spans, panel("sum(rate(traces_span_metrics_calls_total[$__rate_interval]))"))).toEqual([
      'Dashboard "D" panel "p" (id 1) query A reads traces_span_metrics_calls_total, which no collector config in the build emits under traces_span_metrics.',
    ]);
    expect(check(prometheus, spans, panel("sum by (http_route) (rate(shop_calls_total[$__rate_interval]))"))).toHaveLength(1);
    expect(check(prometheus, spans, panel('sum by (service_name) (rate(shop_calls_total{service_name=~"$service"}[$__rate_interval]))'))).toEqual([]);
  });

  test("silent without a collector config, and for names outside the namespaces", () => {
    expect(check(prometheus, panel("sum(rate(traces_span_metrics_calls_total[5m]))"))).toEqual([]);
    expect(check(prometheus, new SpanMetricsConnector({}), panel("sum(rate(http_requests_total[5m]))"))).toEqual([]);
  });
});

describe("GRAF118 on the lexicon's own dashboards", () => {
  const exporter = () => new PrometheusExporter({ endpoint: "0.0.0.0:8889" });

  test("RedDashboard over its connector, with and without an exporter namespace", () => {
    const spans = new SpanMetricsConnector({ namespace: "shop", histogram: { unit: "s" } });
    expect(check(prometheus, spans, RedDashboard({ spanMetrics: spans, datasource: prometheus }).dashboard)).toEqual([]);
    const plain = new SpanMetricsConnector({});
    const named = new PrometheusExporter({ endpoint: "0.0.0.0:8889", namespace: "otel" });
    expect(check(prometheus, plain, named, RedDashboard({ spanMetrics: plain, exporter: named, datasource: prometheus }).dashboard)).toEqual([]);
  });

  test.each([
    ["spans", {}],
    ["derived client metrics", { clientMetrics: "derive" }],
    ["provider dimensions and a namespace", { providerDimensions: true, namespace: "ai" }],
  ] as Array<[string, GenAiMetricsOptions]>)("AgentDashboard over genAiPipeline with %s, from the metrics and from GenAiRules", (_label, options) => {
    const collector = genAiPipeline({ ...options, metricExporters: [exporter()] });
    const genAi = genAiComponents(options);
    expect(check(prometheus, ...collector, AgentDashboard({ genAi, datasource: prometheus }).dashboard)).toEqual([]);
    const rules = GenAiRules({ genAi, alerts: { errorRatio: true } });
    expect(check(prometheus, ...collector, AgentDashboard({ rules, datasource: prometheus }).dashboard)).toEqual([]);
  });
});
