/**
 * A per-node agent config for Kubernetes, one file per concern: host metrics
 * and container logs from the node, OTLP from pods, Kubernetes metadata on
 * everything, metrics served for Prometheus to scrape, and traces and logs
 * forwarded to a gateway. This file: the receivers.
 */
import {
  OtlpReceiver,
  HostMetricsReceiver,
  FileLogReceiver,
  type OtlpReceiverConfig,
  type HostMetricsReceiverConfig,
  type FileLogOperator,
} from "@intentius/chant-lexicon-otel";

const podTraffic: OtlpReceiverConfig["protocols"] = { grpc: { endpoint: "0.0.0.0:4317" } };
const otlp = new OtlpReceiver({ protocols: podTraffic });

const scrapers: HostMetricsReceiverConfig["scrapers"] = { cpu: {}, memory: {}, load: {}, filesystem: {}, network: {} };
const hostMetrics = new HostMetricsReceiver({ collection_interval: "30s", root_path: "/hostfs", scrapers });

const containerParser: FileLogOperator = { type: "container", id: "container-parser" };
const containerLogs = new FileLogReceiver({
  include: ["/var/log/pods/*/*/*.log"],
  exclude: ["/var/log/pods/*/otel-agent/*.log"],
  start_at: "end",
  include_file_path: true,
  operators: [containerParser],
});

export { otlp, hostMetrics, containerLogs };
