/**
 * A per-node agent config for Kubernetes, one file per concern: host metrics
 * and container logs from the node, OTLP from pods, Kubernetes metadata on
 * everything, metrics served for Prometheus to scrape, and traces and logs
 * forwarded to a gateway. This file: extensions and the service block.
 */
import {
  HealthCheckExtension,
  PprofExtension,
  ZPagesExtension,
  Service,
  type ServiceTelemetry,
} from "@intentius/chant-lexicon-otel";

const health = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });
const pprof = new PprofExtension({});
const zpages = new ZPagesExtension({});

/** Listing extensions on the Service fixes their start order; without it they start in declaration order. */
const telemetry: ServiceTelemetry = { logs: { level: "info" }, metrics: { level: "basic" } };
const service = new Service({ extensions: [health, zpages, pprof], telemetry });

export { health, pprof, zpages, service };
