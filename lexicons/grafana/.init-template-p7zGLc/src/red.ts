/**
 * Rate, errors and duration per service, from the span metrics the
 * OpenTelemetry collector's `spanmetrics` connector writes. The metric and
 * label names come from the connector's settings, so change them here to
 * match your collector (or pass the connector itself, if the collector is
 * declared with the otel lexicon) and every query follows.
 */
import { Folder, RedDashboard, type SpanKind } from "@intentius/chant-lexicon-grafana";
import { spanMetricsNames } from "@intentius/chant-lexicon-otel";
import { prometheus } from "./datasources";

const milliseconds = { unit: "ms" };
const connector = { namespace: "traces.span.metrics", histogram: milliseconds };
const names = spanMetricsNames(connector);

// The spans that serve a request or consume a message, so a service's own
// outgoing calls don't count toward its rate. [] counts every kind.
const served: SpanKind[] = ["SPAN_KIND_SERVER", "SPAN_KIND_CONSUMER"];

// A Folder pins the uid, for links and alert rules that name it.
const observability = new Folder({ title: "Observability", uid: "observability" });

const services = RedDashboard({ spanMetrics: names, datasource: prometheus, spanKinds: served, folder: observability, uid: "services-red" });

export { observability, services };
