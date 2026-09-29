/**
 * One ordinary dashboard in one file, panels and queries inline (chant #2957).
 * Panels, rows, queries and variables are property-kind, so core lint neither
 * counts them toward COR009 nor flags the objects they hold under COR001, and
 * the dashboard that holds them is not COR004 dead code.
 */
import { Dashboard, Datasource, Row, TimeSeriesPanel, StatPanel, PromQuery, QueryVariable } from "@intentius/chant-lexicon-grafana";

export const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });

export const service = new QueryVariable({ name: "service", datasource: prometheus, query: "label_values(up, job)" });

const lastHour = { from: "now-1h", to: "now" };

export const overview = new Dashboard({
  title: "Overview",
  uid: "overview",
  time: lastHour,
  variables: [service],
  panels: [
    new Row({
      title: "RED",
      panels: [
        new StatPanel({
          title: "Errors",
          targets: [new PromQuery({ expr: "sum(rate(errors_total[5m]))" })],
          fieldConfig: { defaults: { unit: "percentunit" } },
          options: { graphMode: "area" },
        }),
        new TimeSeriesPanel({
          title: "Rate",
          targets: [new PromQuery({ expr: "sum(rate(requests_total[5m]))", legendFormat: "{{job}}" })],
          fieldConfig: { defaults: { unit: "reqps" } },
        }),
        new TimeSeriesPanel({
          title: "Latency p95",
          targets: [new PromQuery({ expr: "histogram_quantile(0.95, sum by (le) (rate(duration_bucket[5m])))" })],
          fieldConfig: { defaults: { unit: "s" } },
        }),
        new TimeSeriesPanel({ title: "In flight", targets: [new PromQuery({ expr: "sum(in_flight)" })] }),
      ],
    }),
  ],
});
