/**
 * Type-level guarantees of the hand-written declarations and the panel and
 * query types generated from Grafana's schemas. Each `@ts-expect-error` line
 * must fail to compile: `tsconfig.typecheck.json` (scripts/typecheck.ts in CI)
 * fails on an unused one, so a type that starts accepting what it used to
 * reject breaks the build. The invalid declarations sit in functions that are
 * never called, so nothing here throws at runtime.
 */
import { describe, expectTypeOf, test } from "vitest";
import { Slo } from "@intentius/chant-lexicon-prometheus";
import {
  Dashboard,
  Datasource,
  LokiQuery,
  PromQuery,
  RedDashboard,
  SloDashboard,
  StatPanel,
  TimeSeriesPanel,
  type DashboardEntity,
  type SpanKind,
} from "./index";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });
const loki = new Datasource({ name: "Loki", type: "loki", url: "http://loki:3100" });
const up = new PromQuery({ expr: "sum(up)" });

describe("dashboards and panels", () => {
  test("a dashboard needs a title, and holds panels, not queries", () => {
    const panel = new StatPanel({ title: "Up", datasource: prometheus, targets: [up] });
    expectTypeOf(new Dashboard({ title: "Overview", panels: [panel] })).toEqualTypeOf<DashboardEntity>();

    const rejected = () => [
      // @ts-expect-error a dashboard without a title
      new Dashboard({ panels: [panel] }),
      // @ts-expect-error a query is not a panel
      new Dashboard({ title: "Overview", panels: [up] }),
      // @ts-expect-error a panel is not a query
      new StatPanel({ title: "Up", targets: [panel] }),
      // @ts-expect-error the shared tooltip mode is one of three
      new Dashboard({ title: "Overview", graphTooltip: "always" }),
    ];
    void rejected;
  });

  test("panel options and queries follow the vendored schemas", () => {
    new TimeSeriesPanel({ title: "Latency", targets: [up], options: { legend: { displayMode: "table" } } });
    new LokiQuery({ expr: '{job="api"}' });

    const rejected = () => [
      // @ts-expect-error not a legend display mode in the timeseries schema
      new TimeSeriesPanel({ title: "Latency", options: { legend: { displayMode: "grid" } } }),
      // @ts-expect-error a field config unit is a string id such as "ms"
      new TimeSeriesPanel({ title: "Latency", fieldConfig: { defaults: { unit: 1000 } } }),
      // @ts-expect-error a Prometheus query's expression is PromQL text
      new PromQuery({ expr: 42 }),
    ];
    void rejected;
  });
});

describe("composites", () => {
  test("RedDashboard reads a Prometheus datasource and the span kinds the connector writes", () => {
    expectTypeOf<SpanKind>().toEqualTypeOf<
      "SPAN_KIND_UNSPECIFIED" | "SPAN_KIND_INTERNAL" | "SPAN_KIND_SERVER" | "SPAN_KIND_CLIENT" | "SPAN_KIND_PRODUCER" | "SPAN_KIND_CONSUMER"
    >();

    const rejected = () => [
      // @ts-expect-error the RED queries are PromQL, so a Loki datasource can't serve them
      RedDashboard({ spanMetrics: undefined!, datasource: loki }),
      // @ts-expect-error span kinds are the connector's SPAN_KIND_* values
      RedDashboard({ spanMetrics: undefined!, datasource: prometheus, spanKinds: ["server"] }),
    ];
    void rejected;
  });

  test("SloDashboard needs the SLO it charts", () => {
    const sli = { errors: "sum(rate(errors_total[{{window}}]))", total: "sum(rate(requests_total[{{window}}]))" };
    const checkout = Slo({ name: "checkout", objective: 0.999, window: "30d", sli });
    expectTypeOf(SloDashboard({ slo: checkout, datasource: prometheus }).dashboard).toEqualTypeOf<DashboardEntity>();

    const rejected = () => [
      // @ts-expect-error a dashboard for no SLO
      SloDashboard({ datasource: prometheus }),
      // @ts-expect-error SLO props are not a built SLO, its rule group or its metrics
      SloDashboard({ slo: { name: "checkout" }, datasource: prometheus }),
    ];
    void rejected;
  });
});
