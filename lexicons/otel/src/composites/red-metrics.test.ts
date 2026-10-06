/**
 * `RedMetrics`: the collector config it declares, the names it serves, and
 * the RED queries `spanMetricsRedQueries()` builds from them for the grafana
 * and prometheus lexicons.
 */
import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { RedMetrics, redMetricsNames, redMetricsPropsProblem, type RedMetricsProps } from "./index";
import { ForwardConnector } from "../components/connectors";
import { OtlpExporter, PrometheusExporter } from "../components/exporters";
import { collectorYaml } from "../collector";
import { validateCollectorConfig } from "../validate-config";
import type { CollectorConfig } from "../model";
import { spanMetricsNames, spanMetricsRedQueries, RED_DEFAULT_SPAN_KINDS, SPAN_METRICS_KINDS, promErrorRatio } from "../metric-names";

function configOf(props: RedMetricsProps = {}): CollectorConfig {
  return load(collectorYaml(Object.values(RedMetrics(props).members) as Declarable[])) as CollectorConfig;
}

describe("RedMetrics defaults", () => {
  const config = configOf();

  test("the config passes every config check", () => {
    expect(validateCollectorConfig(config)).toEqual([]);
  });

  test("OTLP in, spanmetrics and servicegraph out of traces/red, metrics/red to a prometheus exporter on 8889", () => {
    expect(Object.keys(config.receivers ?? {})).toEqual(["otlp"]);
    expect(Object.keys(config.connectors ?? {}).sort()).toEqual(["servicegraph/red", "spanmetrics/red"]);
    expect(config.exporters).toEqual({ "prometheus/red": { endpoint: "0.0.0.0:8889" } });
    expect(config.service?.pipelines).toEqual({
      "traces/red": { receivers: ["otlp"], processors: ["memory_limiter", "batch"], exporters: ["spanmetrics/red", "servicegraph/red"] },
      "metrics/red": { receivers: ["spanmetrics/red", "servicegraph/red"], processors: ["batch"], exporters: ["prometheus/red"] },
    });
  });

  test("memory_limiter defaults to a share of the container's memory", () => {
    expect(config.processors?.memory_limiter).toEqual({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
  });

  test("the served names are the connector defaults'", () => {
    const names = redMetricsNames(RedMetrics({}));
    expect(names.spans.calls.prometheus).toBe("traces_span_metrics_calls_total");
    expect(names.spans.duration?.prometheus).toBe("traces_span_metrics_duration_milliseconds");
    expect(names.serviceGraph?.requests.prometheus).toBe("traces_service_graph_request_total");
  });
});

describe("RedMetrics options", () => {
  test("the spanmetrics config, a trace backend and a named exporter are used as given", () => {
    const tempo = new OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: { insecure: true } });
    const scrape = new PrometheusExporter({ name: "scrape", endpoint: "0.0.0.0:9464", namespace: "edge" });
    const red = RedMetrics({ traceExporters: [tempo], exporter: scrape, spanMetrics: { namespace: "shop", histogram: { unit: "s" } }, name: "shop" });
    const config = load(collectorYaml(Object.values(red.members) as Declarable[])) as CollectorConfig;
    expect(validateCollectorConfig(config)).toEqual([]);
    expect(config.connectors?.["spanmetrics/shop"]).toEqual({ namespace: "shop", histogram: { unit: "s" } });
    expect(config.service?.pipelines?.["traces/shop"].exporters).toEqual(["spanmetrics/shop", "servicegraph/shop", "otlp/tempo"]);
    expect(config.service?.pipelines?.["metrics/shop"].exporters).toEqual(["prometheus/scrape"]);
    const names = redMetricsNames(red);
    expect(names.spans.calls.prometheus).toBe("edge_shop_calls_total");
    expect(names.spans.duration?.prometheus).toBe("edge_shop_duration_seconds");
    expect(names.spans).toEqual(spanMetricsNames(red.spanMetrics, red.exporter));
  });

  test("serviceGraph: false leaves the servicegraph connector out", () => {
    const red = RedMetrics({ serviceGraph: false });
    expect(red.serviceGraph).toBeUndefined();
    expect(Object.keys(red.members)).not.toContain("serviceGraph");
    const config = configOf({ serviceGraph: false });
    expect(Object.keys(config.connectors ?? {})).toEqual(["spanmetrics/red"]);
    expect(redMetricsNames(red).serviceGraph).toBeUndefined();
    expect(validateCollectorConfig(config)).toEqual([]);
  });

  test("receivers replace the otlp receiver, e.g. a connector from another traces pipeline", () => {
    const fwd = new ForwardConnector({ name: "red" });
    const red = RedMetrics({ receivers: [fwd] });
    expect(red.otlp).toBeUndefined();
    expect(red.traces.props.receivers).toEqual([fwd]);
  });

  test("memoryLimitMib sets a hard limit with a quarter of it as spike limit", () => {
    expect(configOf({ memoryLimitMib: 512 }).processors?.memory_limiter).toEqual({ check_interval: "1s", limit_mib: 512, spike_limit_mib: 128 });
  });

  test("bad props are refused", () => {
    expect(redMetricsPropsProblem({})).toBeUndefined();
    expect(() => RedMetrics({ receivers: [] })).toThrow(/RedMetrics: receivers must name at least one receiver/);
    expect(() => RedMetrics({ memoryLimitMib: 0 })).toThrow(/memoryLimitMib/);
    expect(() => RedMetrics({ name: "a b" })).toThrow(/name "a b"/);
    const notPrometheus = new OtlpExporter({ endpoint: "x:4317" }) as unknown as RedMetricsProps["exporter"];
    expect(() => RedMetrics({ exporter: notPrometheus })).toThrow(/exporter must be a prometheus exporter/);
  });
});

describe("spanMetricsRedQueries", () => {
  const names = spanMetricsNames({ namespace: "shop", histogram: { unit: "s" } });

  test("rate, error ratio and quantiles per service over server and consumer spans", () => {
    const q = spanMetricsRedQueries(names, { range: "5m", quantiles: [0.95] });
    const kinds = `span_kind=~"${RED_DEFAULT_SPAN_KINDS.join("|")}"`;
    expect(q.service).toBe("service_name");
    expect(q.rate).toBe(`sum by (service_name) (rate(shop_calls_total{${kinds}}[5m]))`);
    expect(q.errorRatio).toBe(
      promErrorRatio(`shop_calls_total{${kinds}, status_code="STATUS_CODE_ERROR"}`, `shop_calls_total{${kinds}}`, ["service_name"], "5m"),
    );
    expect(q.duration).toEqual([
      { quantile: 0.95, expr: `histogram_quantile(0.95, sum by (le, service_name) (rate(shop_duration_seconds_bucket{${kinds}}[5m])))` },
    ]);
  });

  test("a service match, extra labels and every span kind", () => {
    const q = spanMetricsRedQueries(names, { range: "$__rate_interval", serviceMatch: "$service", spanKinds: [], by: ["env"] });
    expect(q.kindMatchers).toEqual([]);
    expect(q.rate).toBe('sum by (service_name, env) (rate(shop_calls_total{service_name=~"$service"}[$__rate_interval]))');
    expect(q.duration.map((d) => d.quantile)).toEqual([0.5, 0.95, 0.99]);
  });

  test("errors name the caller", () => {
    expect(() => spanMetricsRedQueries(spanMetricsNames({ exclude_dimensions: ["status.code"] }), { range: "5m", owner: "X" })).toThrow(
      /^X: the connector excludes status.code/,
    );
    expect(() => spanMetricsRedQueries(names, { range: "5m", spanKinds: ["SPAN_KIND_NOPE" as never] })).toThrow(/unknown span kind/);
    expect(SPAN_METRICS_KINDS).toHaveLength(6);
  });

  test("no histogram, no duration queries", () => {
    expect(spanMetricsRedQueries(spanMetricsNames({ histogram: { disable: true } }), { range: "5m" }).duration).toEqual([]);
  });
});
