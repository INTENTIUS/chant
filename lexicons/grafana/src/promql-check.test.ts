/**
 * GRAF108's pieces: template-variable substitution, the PromQL inside a
 * Prometheus query variable, and which queries of a dashboard get parsed.
 * The check itself, over built and hand-written dashboards, is in
 * lint/post-synth/post-synth.test.ts.
 */
import { describe, expect, test } from "vitest";
import { checkGrafanaPromql, prometheusQueries, substituteTemplateVariables, variablePromql } from "./promql-check";
import { knownDatasources } from "./datasource-refs";

describe("substituteTemplateVariables", () => {
  test.each([
    ['sum(rate(x{a=~"$a"}[$__rate_interval]))', 'sum(rate(x{a=~"$a"}[5m]))'],
    ["rate(x[$__interval:$__interval])", "rate(x[5m:5m])"],
    ["rate(x[${window}]) offset $shift", "rate(x[5m]) offset 5m"],
    ["rate(x[${minutes}m])", "rate(x[1m])"],
    ['$metric{job="a"} / $__range_s', 'grafana_var{job="a"} / 1'],
    ["sum by ($group) (x) * $__interval_ms", "sum by (grafana_var) (x) * 1"],
    ["x @ ${__to:date:seconds}", "x @ 1"],
    ["rate([[metric]][[[w]]])", "rate(grafana_var[5m])"],
    ["topk(${n:raw}, x)", "topk(grafana_var, x)"],
    ["x{a='$a', b=`$b`}", "x{a='$a', b=`$b`}"],
    ['x{a="\\"$a"}[$__range]', 'x{a="\\"$a"}[5m]'],
  ])("%s", (query, text) => {
    expect(substituteTemplateVariables(query).text).toBe(text);
  });

  test("maps offsets in the substituted text back to the query", () => {
    const s = substituteTemplateVariables("rate(x[$__rate_interval]) +");
    expect(s.text).toBe("rate(x[5m]) +");
    expect(s.originalOffset(7)).toBe(7);
    expect(s.originalOffset(8)).toBe(7);
    expect(s.originalOffset(11)).toBe(25);
  });
});

describe("checkGrafanaPromql", () => {
  test("passes the queries Grafana's own dashboards use", () => {
    for (const q of [
      'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{route=~"$route"}[$__rate_interval])))',
      'sum by (route) (rate(http_requests_total{job=~"$job", env=~"$env"}[$window]))',
      "sum(increase(x[$__range])) / ($__range_s)",
      'up{instance=~"[[instance]]"}',
    ]) {
      expect({ q, r: checkGrafanaPromql(q) }).toEqual({ q, r: { ok: true } });
    }
  });

  test("reports an unbalanced expression against the original text", () => {
    const r = checkGrafanaPromql('sum(x{cluster="$cluster"}');
    expect(r).toEqual({ ok: false, message: expect.stringContaining('ends early (after "sum(x{cluster="$cluster"}")') });
  });

  test("reports the offset in the query as written, not as substituted", () => {
    const r = checkGrafanaPromql("rate(x[$__rate_interval]) by");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/offset 2\d: "rate\(x\[\$__rate_interval\]\) ?" >>> /);
  });
});

describe("variablePromql", () => {
  test.each([
    ["label_names()", []],
    ['label_names(up{job="a"})', ['up{job="a"}']],
    ["label_values(job)", []],
    ['label_values(up{env="$env"}, job)', ['up{env="$env"}']],
    ["metrics(^http_.*)", []],
    ["query_result(topk(5, sum by (job) (up)))", ["topk(5, sum by (job) (up))"]],
    ['up{job="a"}', ['up{job="a"}']],
    ["  ", []],
  ])("%s", (query, promql) => {
    expect(variablePromql(query)).toEqual(promql);
  });
});

describe("prometheusQueries", () => {
  const known = knownDatasources([
    { name: "Prometheus", type: "prometheus", uid: "prom" },
    { name: "Loki", type: "loki", uid: "loki" },
  ]);
  const dashboard = {
    templating: {
      list: [
        { type: "datasource", name: "ds", query: "prometheus" },
        { type: "query", name: "job", datasource: { type: "prometheus", uid: "prom" }, query: { query: "label_values(up, job)", refId: "V" } },
        { type: "query", name: "stream", datasource: { type: "loki", uid: "loki" }, query: "label_values(app)" },
      ],
    },
    panels: [
      { id: 1, title: "a", type: "stat", datasource: { type: "prometheus", uid: "prom" }, targets: [{ refId: "A", expr: "up" }, { refId: "B", expr: "" }] },
      { id: 2, title: "b", type: "logs", datasource: { type: "loki", uid: "loki" }, targets: [{ refId: "A", expr: '{app="x"} |= "error"' }] },
      { id: 3, title: "c", type: "stat", datasource: { type: "prometheus", uid: "${ds}" }, targets: [{ refId: "A", expr: "sum(up)" }] },
      { id: 4, title: "d", type: "stat", targets: [{ refId: "A", expr: "no datasource" }] },
      { id: 5, title: "e", type: "stat", datasource: { type: "datasource", uid: "-- Mixed --" }, targets: [{ refId: "A", expr: "x", datasource: { type: "loki", uid: "loki" } }, { refId: "B", expr: "y", datasource: { type: "prometheus", uid: "prom" } }] },
    ],
    __elements: { lib: { name: "lib", kind: 1, model: { type: "stat", datasource: { type: "prometheus", uid: "prom" }, targets: [{ refId: "A", expr: "rate(x[5m])" }] } } },
  };

  test("takes only the queries that reach a Prometheus, including library panels", () => {
    expect(prometheusQueries(dashboard, known)).toEqual([
      { where: 'panel "a" (id 1) query A', expr: "up" },
      { where: 'panel "c" (id 3) query A', expr: "sum(up)" },
      { where: 'panel "e" (id 5) query B', expr: "y" },
      { where: 'variable "job" query', expr: "up" },
      { where: 'library panel "lib" query A', expr: "rate(x[5m])" },
    ]);
  });
});
