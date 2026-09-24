/**
 * A per-node agent config for Kubernetes, one file per concern: host metrics
 * and container logs from the node, OTLP from pods, Kubernetes metadata on
 * everything, metrics served for Prometheus to scrape, and traces and logs
 * forwarded to a gateway. This file: the pipelines.
 */
import { Pipeline } from "@intentius/chant-lexicon-otel";
import { otlp, hostMetrics, containerLogs } from "./receivers";
import { memoryLimiter, k8sMetadata, detect, cluster, redact, batch } from "./processors";
import { gateway, prometheus } from "./exporters";

const metrics = new Pipeline({
  signal: "metrics",
  receivers: [otlp, hostMetrics],
  processors: [memoryLimiter, k8sMetadata, detect, cluster, batch],
  exporters: [prometheus],
});

const traces = new Pipeline({
  signal: "traces",
  receivers: [otlp],
  processors: [memoryLimiter, k8sMetadata, detect, cluster, redact, batch],
  exporters: [gateway],
});

const logs = new Pipeline({
  signal: "logs",
  receivers: [containerLogs, otlp],
  processors: [memoryLimiter, k8sMetadata, cluster, batch],
  exporters: [gateway],
});

export { metrics, traces, logs };
