/**
 * A per-node agent config for Kubernetes, one file per concern: host metrics
 * and container logs from the node, OTLP from pods, Kubernetes metadata on
 * everything, metrics served for Prometheus to scrape, and traces and logs
 * forwarded to a gateway. This file: the exporters.
 */
import { OtlpExporter, PrometheusExporter, type TLSClientSettings, type RetrySettings } from "@intentius/chant-lexicon-otel";

const inCluster: TLSClientSettings = { insecure: true };
const retry: RetrySettings = { enabled: true, max_elapsed_time: "300s" };
const gateway = new OtlpExporter({
  name: "gateway",
  endpoint: "otel-gateway.observability.svc:4317",
  tls: inCluster,
  retry_on_failure: retry,
});

const resourceLabels = { enabled: true };
const prometheus = new PrometheusExporter({ endpoint: "0.0.0.0:8889", resource_to_telemetry_conversion: resourceLabels });

export { gateway, prometheus };
