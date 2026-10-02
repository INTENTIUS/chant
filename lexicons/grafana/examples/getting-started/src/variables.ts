/**
 * The dashboard's variables: which service to look at, and a trace id for
 * the trace panel. Queries use them as $service and $traceId.
 */
import { QueryVariable, TextboxVariable } from "@intentius/chant-lexicon-grafana";
import { prometheus } from "./datasources";

const service = new QueryVariable({
  name: "service",
  label: "Service",
  datasource: prometheus,
  query: "label_values(traces_span_metrics_calls_total, service_name)",
  refresh: "onTimeRangeChange",
  sort: 1,
});

const traceId = new TextboxVariable({ name: "traceId", label: "Trace id" });

export { service, traceId };
