/**
 * PROM301 (#3364): rule selectors under a connector namespace against what
 * the build's collector configs emit.
 */
import { describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { makePostSynthCtx, makePostSynthCtxFromFiles } from "@intentius/chant-test-utils";
import { PrometheusExporter, ServiceGraphConnector, SpanMetricsConnector } from "@intentius/chant-lexicon-otel/components/index";
import { genAiMetrics, genAiPipeline, type GenAiMetricsOptions } from "@intentius/chant-lexicon-otel/genai";
import { collectorYaml } from "@intentius/chant-lexicon-otel/collector";
import { prom301 } from "./prom301";
import { emitYaml } from "../../build";
import { ruleGroupConfig } from "../../rules";
import { GenAiRules, type GenAiAlerting, type GenAiPrice } from "../../composites/genai";
import { Slo } from "../../composites/slo";
import type { RuleGroupConfig } from "../../model";

const entities = (...list: Declarable[]) => new Map(list.map((e, i) => [`e${i}`, e] as [string, Declarable]));

/** A rule file of one recording rule per expression. */
function rules(...exprs: string[]): string {
  return JSON.stringify({ groups: [{ name: "g", rules: exprs.map((expr, i) => ({ record: `job:r${i}:rate5m`, expr })) }] });
}

/** PROM301's messages for a rule file, with the collector declared as otel entities in the same build. */
function found(text: string, ...collector: Declarable[]): string[] {
  return prom301.check(makePostSynthCtx("prometheus", text, entities(...collector))).map((d) => d.message);
}

describe("PROM301", () => {
  test("a rule reading traces_span_metrics_calls_total with no spanmetrics connector of that namespace is reported", () => {
    const msgs = found(rules("sum by (service_name) (rate(traces_span_metrics_calls_total[5m]))"), new SpanMetricsConnector({ namespace: "shop" }));
    expect(msgs).toEqual(["rule g/job:r0:rate5m reads traces_span_metrics_calls_total, which no collector config in the build emits under traces_span_metrics"]);
  });

  test("the names a declared connector emits pass, a misspelt one under its namespace does not", () => {
    const shop = new SpanMetricsConnector({ namespace: "shop", histogram: { unit: "s" } });
    expect(found(rules("sum by (service_name) (rate(shop_calls_total[5m]))", "histogram_quantile(0.9, sum by (le) (rate(shop_duration_seconds_bucket[5m])))"), shop)).toEqual([]);
    expect(found(rules("sum(rate(shop_call_total[5m]))"), shop)).toEqual([
      "rule g/job:r0:rate5m reads shop_call_total, which no collector config in the build emits under shop",
    ]);
    // A duration histogram in ms, read as seconds.
    expect(found(rules("sum(rate(traces_span_metrics_duration_seconds_count[5m]))"), new SpanMetricsConnector({}))).toHaveLength(1);
  });

  test("a by (...) label that is not a declared dimension", () => {
    const spans = new SpanMetricsConnector({ dimensions: [{ name: "http.route" }] });
    expect(found(rules("sum by (service_name, http_route, job) (rate(traces_span_metrics_calls_total[5m]))"), spans)).toEqual([]);
    expect(found(rules("sum by (http_method) (rate(traces_span_metrics_calls_total[5m]))"), spans)).toEqual([
      "rule g/job:r0:rate5m groups traces_span_metrics_calls_total by http_method, which is not a dimension the collector config declares for it",
    ]);
    // le belongs to the _bucket series only.
    expect(found(rules("sum by (le) (rate(traces_span_metrics_duration_milliseconds_count[5m]))"), spans)).toHaveLength(1);
    // label_replace writes a label of its own, so the aggregation over it is not checked.
    expect(found(rules('sum by (route) (label_replace(rate(traces_span_metrics_calls_total[5m]), "route", "$1", "http_route", "(.*)"))'), spans)).toEqual([]);
  });

  test("an exporter that copies every resource attribute leaves the labels open", () => {
    const spans = new SpanMetricsConnector({});
    const exporter = new PrometheusExporter({ endpoint: "0.0.0.0:8889", resource_to_telemetry_conversion: { enabled: true } });
    expect(found(rules("sum by (k8s_namespace_name) (rate(traces_span_metrics_calls_total[5m]))"), spans, exporter)).toEqual([]);
  });

  test("the exporter's namespace moves every name", () => {
    const spans = new SpanMetricsConnector({});
    const exporter = new PrometheusExporter({ endpoint: "0.0.0.0:8889", namespace: "otel" });
    expect(found(rules("sum(rate(otel_traces_span_metrics_calls_total[5m]))"), spans, exporter)).toEqual([]);
    expect(found(rules("sum(rate(otel_traces_span_metrics_call_total[5m]))"), spans, exporter)).toHaveLength(1);
  });

  test("servicegraph names and labels", () => {
    const graph = new ServiceGraphConnector({ dimensions: ["http.method"] });
    expect(found(rules("sum by (client, server, client_http_method) (rate(traces_service_graph_request_total[5m]))"), graph)).toEqual([]);
    expect(found(rules("sum by (client) (rate(traces_service_graph_request_duration_seconds_count[5m]))"), graph)).toHaveLength(1);
    expect(found(rules("sum by (peer) (rate(traces_service_graph_request_failed_total[5m]))"), graph)).toHaveLength(1);
  });

  test("silent for names outside every namespace, and with no collector config in the build", () => {
    expect(found(rules("sum by (job) (rate(http_requests_total[5m]))"), new SpanMetricsConnector({}))).toEqual([]);
    expect(found(rules("sum by (nope) (rate(traces_span_metrics_calls_totl[5m]))"))).toEqual([]);
  });

  test("reads a collector config from the output too, as in a ConfigMap or a multi-lexicon context", () => {
    const yaml = collectorYaml(genAiPipeline({ namespace: "shop" }));
    const ctx = makePostSynthCtxFromFiles("prometheus", { "collector.yaml": yaml }, rules("sum(rate(traces_span_metrics_calls_total[5m]))"));
    expect(prom301.check(ctx)).toHaveLength(1);
  });
});

describe("PROM301 reads renamed connector types as the built-ins they name", () => {
  const config = (connectors: string) => `receivers:
  otlp: {}
exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
connectors:
${connectors}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`;
  const ctx = (yaml: string, text: string) => makePostSynthCtxFromFiles("prometheus", { "collector.yaml": yaml }, text);

  test("span_metrics, service_graph and signal_to_metrics", () => {
    const yaml = config(`  span_metrics/shop:
    namespace: shop
  service_graph: {}
  signal_to_metrics/genai_client:
    spans:
      - name: gen_ai.client.operation.duration
        unit: s
        attributes: [{ key: gen_ai.operation.name }]
        histogram: { buckets: [1] }
`);
    const read = rules(
      "sum by (service_name) (rate(shop_calls_total[5m]))",
      "sum by (client) (rate(traces_service_graph_request_total[5m]))",
      "sum by (gen_ai_operation_name, le) (rate(gen_ai_client_operation_duration_seconds_bucket[5m]))",
    );
    expect(prom301.check(ctx(yaml, read))).toEqual([]);
    expect(prom301.check(ctx(yaml, rules("sum(rate(shop_call_total[5m]))", "sum(rate(gen_ai_client_operation_seconds_count[5m]))"))).map((d) => d.entity)).toEqual([
      "g/job:r0:rate5m",
      "g/job:r1:rate5m",
    ]);
  });
});

describe("PROM301 on the lexicon's own rules", () => {
  const groupYaml = (group: RuleGroupConfig) => emitYaml({ groups: [group] });
  const prices: GenAiPrice[] = [{ provider: "anthropic", model: "m1", inputPerMTok: 3, outputPerMTok: 15, currency: "USD", source: "https://example.com", asOf: "2026-09-29" }];
  const alerts: GenAiAlerting = { errorRatio: true, latency: true, toolErrorRatio: true, budgets: [{ amount: 5, currency: "USD", per: "hour" }] };

  test.each([
    ["spans", {}],
    ["derived client metrics", { clientMetrics: "derive" }],
    ["provider dimensions and a namespace", { providerDimensions: true, namespace: "ai" }],
  ] as Array<[string, GenAiMetricsOptions]>)("GenAiRules over genAiPipeline with %s, with and without its alerts", (_label, options) => {
    const collector = genAiPipeline({ ...options, metricExporters: [new PrometheusExporter({ endpoint: "0.0.0.0:8889" })] });
    const genAi = genAiMetrics(options);
    for (const props of [{ genAi, prices }, { genAi, prices, alerts }]) {
      expect(found(groupYaml(ruleGroupConfig(GenAiRules(props).rules)), ...collector)).toEqual([]);
    }
  });

  test("Slo over the default spanmetrics connector", () => {
    const calls = "traces_span_metrics_calls_total";
    const slo = Slo({
      name: "checkout",
      objective: 0.999,
      window: "30d",
      sli: { errors: `sum(rate(${calls}{span_name="checkout",status_code="STATUS_CODE_ERROR"}[{{window}}]))`, total: `sum(rate(${calls}{span_name="checkout"}[{{window}}]))` },
    });
    expect(found(groupYaml(ruleGroupConfig(slo.rules)), new SpanMetricsConnector({}))).toEqual([]);
  });
});
