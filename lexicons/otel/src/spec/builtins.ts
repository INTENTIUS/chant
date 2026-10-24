/**
 * The built-in components, as the schema snapshot and the generator see them:
 * class name, kind and collector type. Kept apart from `../components` so the
 * snapshot refresh and generation load no component code (the components
 * import the types generation writes). `builtins.test.ts` holds this list to
 * the exported classes.
 */

import type { ComponentKind } from "../model";

export interface BuiltinSpec {
  /** The exported class, e.g. `OtlpReceiver`. The generated config type is `<className>SchemaConfig`. */
  className: string;
  kind: ComponentKind;
  /** The type the class writes, which may be the older name of a renamed component. */
  type: string;
}

export const BUILTIN_SPECS: readonly BuiltinSpec[] = [
  { className: "OtlpReceiver", kind: "receiver", type: "otlp" },
  { className: "PrometheusReceiver", kind: "receiver", type: "prometheus" },
  { className: "HostMetricsReceiver", kind: "receiver", type: "hostmetrics" },
  { className: "FileLogReceiver", kind: "receiver", type: "filelog" },
  { className: "K8sClusterReceiver", kind: "receiver", type: "k8s_cluster" },
  { className: "KubeletStatsReceiver", kind: "receiver", type: "kubeletstats" },
  { className: "BatchProcessor", kind: "processor", type: "batch" },
  { className: "MemoryLimiterProcessor", kind: "processor", type: "memory_limiter" },
  { className: "ResourceProcessor", kind: "processor", type: "resource" },
  { className: "AttributesProcessor", kind: "processor", type: "attributes" },
  { className: "K8sAttributesProcessor", kind: "processor", type: "k8sattributes" },
  { className: "ResourceDetectionProcessor", kind: "processor", type: "resourcedetection" },
  { className: "DeltaToCumulativeProcessor", kind: "processor", type: "deltatocumulative" },
  { className: "FilterProcessor", kind: "processor", type: "filter" },
  { className: "TransformProcessor", kind: "processor", type: "transform" },
  { className: "RedactionProcessor", kind: "processor", type: "redaction" },
  { className: "TailSamplingProcessor", kind: "processor", type: "tail_sampling" },
  { className: "ProbabilisticSamplerProcessor", kind: "processor", type: "probabilistic_sampler" },
  { className: "OtlpExporter", kind: "exporter", type: "otlp" },
  { className: "OtlpHttpExporter", kind: "exporter", type: "otlphttp" },
  { className: "DebugExporter", kind: "exporter", type: "debug" },
  { className: "PrometheusExporter", kind: "exporter", type: "prometheus" },
  { className: "GoogleCloudExporter", kind: "exporter", type: "googlecloud" },
  { className: "LoadBalancingExporter", kind: "exporter", type: "loadbalancing" },
  { className: "SpanMetricsConnector", kind: "connector", type: "spanmetrics" },
  { className: "ServiceGraphConnector", kind: "connector", type: "servicegraph" },
  { className: "RoutingConnector", kind: "connector", type: "routing" },
  { className: "ForwardConnector", kind: "connector", type: "forward" },
  { className: "CountConnector", kind: "connector", type: "count" },
  { className: "SumConnector", kind: "connector", type: "sum" },
  { className: "SignalToMetricsConnector", kind: "connector", type: "signaltometrics" },
  { className: "HealthCheckExtension", kind: "extension", type: "health_check" },
  { className: "PprofExtension", kind: "extension", type: "pprof" },
  { className: "ZPagesExtension", kind: "extension", type: "zpages" },
  { className: "K8sLeaderElectorExtension", kind: "extension", type: "k8s_leader_elector" },
];
