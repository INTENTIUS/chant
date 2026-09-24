/**
 * GkeOtelCollector composite — DaemonSet + RBAC + ConfigMap for OpenTelemetry on GKE.
 *
 * @gke Like AdotCollector but targets Cloud Trace + Cloud Monitoring via the
 * googlecloud exporter and uses GKE Workload Identity instead of IRSA.
 *
 * The collector config is typed through the otel lexicon
 * (`@intentius/chant-lexicon-otel`) and rendered with its `collectorYaml`, so
 * it is checked the way any declared collector config is.
 */

import { Composite } from "@intentius/chant";
import {
  OtlpReceiver,
  BatchProcessor,
  ResourceDetectionProcessor,
  GoogleCloudExporter,
  Pipeline,
  collectorYaml,
} from "@intentius/chant-lexicon-otel";
import { collectorAgentResources, type CollectorAgentResources } from "./otel-collector-agent";

export interface GkeOtelCollectorProps {
  /** GKE cluster name. */
  clusterName: string;
  /** GCP project ID. */
  projectId: string;
  /** GCP service account email for Workload Identity. */
  gcpServiceAccountEmail?: string;
  /** Agent name (default: "gke-otel-collector"). */
  name?: string;
  /** OTel Collector image (default: "otel/opentelemetry-collector-contrib:latest"). */
  image?: string;
  /** Namespace (default: "gke-monitoring"). */
  namespace?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** CPU request (default: "100m"). */
  cpuRequest?: string;
  /** Memory request (default: "256Mi"). */
  memoryRequest?: string;
  /** CPU limit (default: "500m"). */
  cpuLimit?: string;
  /** Memory limit (default: "512Mi"). */
  memoryLimit?: string;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    daemonSet?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
    configMap?: Partial<Record<string, unknown>>;
  };
}

export type GkeOtelCollectorResult = CollectorAgentResources;

/**
 * Create a GkeOtelCollector composite — returns prop objects for
 * a DaemonSet, ServiceAccount, ClusterRole, ClusterRoleBinding, and ConfigMap.
 *
 * @gke
 * @example
 * ```ts
 * import { GkeOtelCollector } from "@intentius/chant-lexicon-k8s";
 *
 * const { daemonSet, serviceAccount, clusterRole, clusterRoleBinding, configMap } = GkeOtelCollector({
 *   clusterName: "my-cluster",
 *   projectId: "my-project",
 *   gcpServiceAccountEmail: "otel@my-project.iam.gserviceaccount.com",
 * });
 * ```
 */
export const GkeOtelCollector = Composite((props: GkeOtelCollectorProps) => {
  const {
    clusterName,
    projectId,
    gcpServiceAccountEmail,
    name = "gke-otel-collector",
    image = "otel/opentelemetry-collector-contrib:latest",
    namespace = "gke-monitoring",
    labels: extraLabels = {},
    cpuRequest = "100m",
    memoryRequest = "256Mi",
    cpuLimit = "500m",
    memoryLimit = "512Mi",
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  // The collector config, declared through the otel lexicon and rendered to
  // the same YAML the ConfigMap has always carried (#2559).
  const otlp = new OtlpReceiver({
    protocols: {
      grpc: { endpoint: "0.0.0.0:4317" },
      http: { endpoint: "0.0.0.0:4318" },
    },
  });
  const batch = new BatchProcessor({ timeout: "30s", send_batch_size: 8192 });
  const resourceDetection = new ResourceDetectionProcessor({ detectors: ["gcp"], timeout: "10s" });
  const googleCloud = new GoogleCloudExporter({
    project: projectId,
    metric: { prefix: `custom.googleapis.com/${clusterName}` },
    trace: {
      attribute_mappings: [{ key: "service.name", replacement: "g.co/r/service/name" }],
    },
  });
  const otelConfig = collectorYaml([
    otlp,
    batch,
    resourceDetection,
    googleCloud,
    new Pipeline({ signal: "metrics", receivers: [otlp], processors: [batch, resourceDetection], exporters: [googleCloud] }),
    new Pipeline({ signal: "traces", receivers: [otlp], processors: [batch, resourceDetection], exporters: [googleCloud] }),
  ]);

  // The DaemonSet, RBAC and ConfigMap are the ones OtelCollector builds too.
  return collectorAgentResources({
    name,
    namespace,
    image,
    commonLabels,
    extraLabels,
    configYaml: otelConfig,
    configDir: "/etc/otel",
    ports: [
      { containerPort: 4317, name: "otlp-grpc" },
      { containerPort: 4318, name: "otlp-http" },
    ],
    cpuRequest,
    memoryRequest,
    cpuLimit,
    memoryLimit,
    ...(gcpServiceAccountEmail
      ? { serviceAccountAnnotations: { "iam.gke.io/gcp-service-account": gcpServiceAccountEmail } }
      : {}),
    defaults: defs,
  });
}, "GkeOtelCollector");
