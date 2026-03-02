/**
 * GkeOtelCollector composite — DaemonSet + RBAC + ConfigMap for OpenTelemetry on GKE.
 *
 * @gke Like AdotCollector but targets Cloud Trace + Cloud Monitoring via the
 * googlecloud exporter and uses GKE Workload Identity instead of IRSA.
 */

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
}

export interface GkeOtelCollectorResult {
  daemonSet: Record<string, unknown>;
  serviceAccount: Record<string, unknown>;
  clusterRole: Record<string, unknown>;
  clusterRoleBinding: Record<string, unknown>;
  configMap: Record<string, unknown>;
}

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
export function GkeOtelCollector(props: GkeOtelCollectorProps): GkeOtelCollectorResult {
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
  } = props;

  const saName = `${name}-sa`;
  const clusterRoleName = `${name}-role`;
  const bindingName = `${name}-binding`;
  const configMapName = `${name}-config`;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const otelConfig = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 30s
    send_batch_size: 8192
  resourcedetection:
    detectors: [gcp]
    timeout: 10s

exporters:
  googlecloud:
    project: ${projectId}
    metric:
      prefix: custom.googleapis.com/${clusterName}
    trace:
      attribute_mappings:
        - key: service.name
          replacement: g.co/r/service/name

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch, resourcedetection]
      exporters: [googlecloud]
    traces:
      receivers: [otlp]
      processors: [batch, resourcedetection]
      exporters: [googlecloud]
`;

  const container: Record<string, unknown> = {
    name,
    image,
    args: ["--config=/etc/otel/config.yaml"],
    ports: [
      { containerPort: 4317, name: "otlp-grpc" },
      { containerPort: 4318, name: "otlp-http" },
    ],
    resources: {
      requests: { cpu: cpuRequest, memory: memoryRequest },
      limits: { cpu: cpuLimit, memory: memoryLimit },
    },
    volumeMounts: [
      { name: "config", mountPath: "/etc/otel", readOnly: true },
    ],
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 10001,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
    },
  };

  const daemonSetProps: Record<string, unknown> = {
    metadata: {
      name,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
    },
    spec: {
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": name, ...extraLabels } },
        spec: {
          serviceAccountName: saName,
          containers: [container],
          volumes: [
            { name: "config", configMap: { name: configMapName } },
          ],
          tolerations: [{ operator: "Exists" }],
        },
      },
    },
  };

  const serviceAccountProps: Record<string, unknown> = {
    metadata: {
      name: saName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "agent" },
      ...(gcpServiceAccountEmail
        ? { annotations: { "iam.gke.io/gcp-service-account": gcpServiceAccountEmail } }
        : {}),
    },
  };

  const clusterRoleProps: Record<string, unknown> = {
    metadata: {
      name: clusterRoleName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    rules: [
      { apiGroups: [""], resources: ["pods", "nodes", "endpoints"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["apps"], resources: ["replicasets"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list", "watch"] },
      { apiGroups: [""], resources: ["nodes/proxy"], verbs: ["get"] },
      { apiGroups: [""], resources: ["nodes/stats", "configmaps", "events"], verbs: ["create", "get"] },
      { apiGroups: [""], resources: ["configmaps"], verbs: ["get", "update", "create"], resourceNames: ["otel-container-insight-clusterleader"] },
    ],
  };

  const clusterRoleBindingProps: Record<string, unknown> = {
    metadata: {
      name: bindingName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "rbac" },
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: clusterRoleName,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: saName,
        namespace,
      },
    ],
  };

  const configMapProps: Record<string, unknown> = {
    metadata: {
      name: configMapName,
      namespace,
      labels: { ...commonLabels, "app.kubernetes.io/component": "config" },
    },
    data: {
      "config.yaml": otelConfig,
    },
  };

  return {
    daemonSet: daemonSetProps,
    serviceAccount: serviceAccountProps,
    clusterRole: clusterRoleProps,
    clusterRoleBinding: clusterRoleBindingProps,
    configMap: configMapProps,
  };
}
