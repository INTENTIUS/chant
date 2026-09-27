/**
 * The queries, one per question. PromQL over the span metrics the
 * OpenTelemetry collector's spanmetrics connector produces, TraceQL for slow
 * traces and one trace by id, LogQL for the service's logs.
 */
import { PromQuery, TempoQuery, LokiQuery } from "@intentius/chant-lexicon-grafana";

const calls = 'traces_span_metrics_calls_total{service_name="$service"}';
const buckets = 'traces_span_metrics_duration_milliseconds_bucket{service_name="$service"}';

const requestRate = new PromQuery({
  expr: `sum by (span_name) (rate(${calls}[$__rate_interval]))`,
  legendFormat: "{{span_name}}",
});

const errorRatio = new PromQuery({
  expr: `sum(rate(traces_span_metrics_calls_total{service_name="$service", status_code="STATUS_CODE_ERROR"}[$__rate_interval])) / sum(rate(${calls}[$__rate_interval]))`,
  instant: true,
});

const latencyP95 = new PromQuery({
  expr: `histogram_quantile(0.95, sum by (le) (rate(${buckets}[$__rate_interval])))`,
  legendFormat: "p95",
});

const latencyBuckets = new PromQuery({ expr: `sum by (le) (rate(${buckets}[$__rate_interval]))`, format: "heatmap" });

const slowTraces = new TempoQuery({ query: '{ resource.service.name = "$service" && duration > 500ms }', limit: 20, tableType: "traces" });

const traceById = new TempoQuery({ query: "$traceId" });

const serviceLogs = new LokiQuery({ expr: '{service_name="$service"} |= ``' });

export { requestRate, errorRatio, latencyP95, latencyBuckets, slowTraces, traceById, serviceLogs };
