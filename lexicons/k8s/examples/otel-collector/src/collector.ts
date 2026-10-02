/**
 * An OpenTelemetry Collector agent on any Kubernetes cluster.
 *
 * OtelCollector runs the collector as a DaemonSet. Pods send OTLP to the
 * `otel-collector.observability.svc` Service, which keeps traffic on the
 * pod's own node. The collector forwards traces and metrics to Tempo and
 * prints logs with the debug exporter.
 *
 * The config is declared with the otel lexicon and passed in whole, so the
 * composite renders exactly these components into its ConfigMap.
 */
import { OtelCollector } from "@intentius/chant-lexicon-k8s";
import { Pipeline } from "@intentius/chant-lexicon-otel";
import { otlp, memoryLimiter, batch, tempo, debug, health } from "./components";

const processors = [memoryLimiter, batch];

export const collector = OtelCollector({
  config: [
    health,
    new Pipeline({ signal: "traces", receivers: [otlp], processors, exporters: [tempo] }),
    new Pipeline({ signal: "metrics", receivers: [otlp], processors, exporters: [tempo] }),
    new Pipeline({ signal: "logs", receivers: [otlp], processors, exporters: [debug] }),
  ],
});
